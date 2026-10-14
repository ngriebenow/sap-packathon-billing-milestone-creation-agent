'use strict';

const cds             = require('@sap/cds');
const fetch           = require('node-fetch');
const sessionStore    = require('./lib/session-store');
const aiCore          = require('./lib/ai-core-client');
const milestoneMapper = require('./lib/milestone-mapper');
const s4Client        = require('./lib/s4-client');

// ── Historical plans from real production data ────────────────────────────────

async function getHistoricalPlans(totalValue) {
  const mockHost = process.env.S4_BASE_URL
    ? process.env.S4_BASE_URL.replace('/sap/opu/odata/sap/API_SALES_ORDER_SRV', '')
    : `http://localhost:${process.env.MOCK_S4_PORT || 3001}`;

  const lo = Math.round(totalValue * 0.5);
  const hi = Math.round(totalValue * 1.5);
  const url = `${mockHost}/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrderBillingPlan?minValue=${lo}&maxValue=${hi}`;

  try {
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const allPlans = body.d?.results || [];

    // Deduplicate by SalesOrder so historical context covers diverse contracts
    const seen = new Set();
    const plans = allPlans.filter(p => {
      if (seen.has(p.SalesOrder)) return false;
      seen.add(p.SalesOrder);
      return true;
    }).slice(0, 10);

    // For each plan, fetch its items
    const enriched = await Promise.all(plans.map(async (plan) => {
      try {
        const itemUrl = `${mockHost}/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrderBillingPlan('${plan.BillingPlan}')/to_BillingPlanItem`;
        const ir = await fetch(itemUrl);
        const ib = await ir.json();
        const items = (ib.d?.results || []).map(it => ({
          item:         it.BillingPlanItem,
          billingDate:  it._billingDateISO || null,
          amount:       parseFloat(it.BillingPlanAmount) || 0,
          percentage:   parseFloat(it.BillingPlanAmountPercent) || 0,
          currency:     it.TransactionCurrency,
          docType:      it.ProposedBillingDocumentType,
          paymentTerms: it.CustomerPaymentTerms || it._paymentTerms || '',
          milestoneCode: it.BillingPlanMilestoneUsage,
        }));
        return {
          salesOrder:      plan.SalesOrder,
          billingPlan:     plan.BillingPlan,
          contractValue:   plan.NetAmount,
          currency:        plan.TransactionCurrency,
          customerName:    plan.CustomerName,
          customerCountry: plan.CustomerCountry,
          incoterms:       plan.Incoterms,
          paymentTerms:    plan.CustomerPaymentTerms,
          milestones:      items,
        };
      } catch {
        return null;
      }
    }));
    return enriched.filter(Boolean);
  } catch (err) {
    console.warn('[getHistoricalPlans] Could not fetch from mock S/4:', err.message);
    return [];
  }
}

// ── Analytics prompt builders ─────────────────────────────────────────────────

// SAP billing plans use percentage=100 on the final F2 invoice as a sentinel
// meaning "invoice the remaining balance", NOT "this milestone is 100% of total".
// We replace it with the true remainder percentage before sending to the model,
// and strip the same sentinel from historical plan items so comparisons are fair.
function normaliseMilestonesForAnalytics(milestones) {
  const interim = milestones.filter(m => m.billingDocumentType !== 'F2');
  const final   = milestones.find(m => m.billingDocumentType === 'F2');
  const interimTotal = interim.reduce((s, m) => s + Number(m.amount || 0), 0);
  const totalValue   = milestones.reduce((s, m) => s + Number(m.amount || 0), 0);

  return milestones.map(m => {
    if (m.billingDocumentType !== 'F2') return m;
    const remainderPct = totalValue > 0
      ? Math.round(((totalValue - interimTotal) / totalValue) * 10000) / 100
      : 0;
    return {
      ...m,
      percentage: remainderPct,
      _note: 'SAP final invoice (F2): percentage=100 in SAP is a "remaining balance" sentinel, replaced here with the true remainder percentage for analytical purposes.'
    };
  });
}

function normaliseHistoricalItems(plans) {
  return plans.map(plan => ({
    ...plan,
    milestones: (plan.milestones || []).map(item => {
      if (item.docType !== 'F2' || Number(item.percentage) !== 100) return item;
      const interimTotal = (plan.milestones || [])
        .filter(i => i.docType !== 'F2')
        .reduce((s, i) => s + Number(i.amount || 0), 0);
      const total = Number(plan.contractValue || 0);
      const remainderPct = total > 0
        ? Math.round(((total - interimTotal) / total) * 10000) / 100
        : 0;
      return { ...item, percentage: remainderPct };
    })
  }));
}

function buildDelayRiskPrompt(milestones, historical) {
  const norm     = normaliseMilestonesForAnalytics(milestones);
  const histNorm = normaliseHistoricalItems(historical);
  const currency = norm[0]?.currency || 'EUR';
  const totalValue = norm.reduce((s, m) => s + Number(m.amount || 0), 0);
  return `You are a payment risk analyst for industrial machinery sales contracts.

SAP billing plan convention: the final F2 invoice has its percentage already corrected to the true remainder (not the SAP sentinel value of 100%). Treat it as a normal milestone when comparing to historical data.

Current billing plan to assess:
- Total contract value: ${totalValue} ${currency}
- Milestones: ${JSON.stringify(norm, null, 2)}

Historical billing plans from real contracts with similar contract values (real production data):
${JSON.stringify(histNorm, null, 2)}

For each milestone in the CURRENT plan, assess payment delay risk. Consider:
- Milestone type (FAZ = down payment / advance, F2 = final invoice)
- Due date proximity to Q4 (Oct–Dec budgets often frozen, delay risk higher)
- Payment terms (e.g. Z001 = immediate, Z002 = 30 days, Z127 = 127 days)
- Incoterms (EXW = buyer collects, CIF/CIP = seller delivers — affects payment timing)
- Historical patterns: what percentages and payment terms appear in similar real contracts
- Contract value bracket (larger contracts have more payment friction)

Return ONLY valid JSON, no markdown fences:
{"risks":[{"milestoneNumber":1,"description":"...","riskLevel":"low|medium|high","reasoning":"one sentence referencing historical data where relevant"}],"summary":"2-3 sentence overall risk assessment referencing patterns from historical data"}`;
}

function buildOptimizationPrompt(milestones, historical) {
  const norm     = normaliseMilestonesForAnalytics(milestones);
  const histNorm = normaliseHistoricalItems(historical);
  const totalValue = norm.reduce((s, m) => s + Number(m.amount || 0), 0);
  const currency = norm[0]?.currency || 'EUR';
  return `You are a billing plan optimization specialist for industrial machinery contracts.

SAP billing plan convention: the final F2 invoice has its percentage already corrected to the true remainder (not the SAP sentinel value of 100%). Treat it as a normal milestone when comparing to historical data.

Current billing milestones (total contract value: ${totalValue} ${currency}):
${JSON.stringify(norm, null, 2)}

Historical billing plans from real contracts with similar contract values (real production data):
${JSON.stringify(histNorm, null, 2)}

Using the historical data as a benchmark, suggest an optimized billing plan that:
1. Improves the seller's cash flow (front-load payments where possible, aligned with historical best practice)
2. Aligns milestone dates with natural project phases seen in similar contracts
3. KEEPS the total contract value IDENTICAL (${totalValue} ${currency})
4. Keeps the same number of milestones
5. Sets percentage=0 for the last (final invoice) milestone in the output JSON (SAP convention)
6. Estimate the financial savings: consider reduced days-sales-outstanding (assume 4% annual cost of capital), avoided late-payment penalties (typical 2% per late invoice), and improved cash availability. Be realistic — savings on a ${totalValue} ${currency} contract are typically between 0.5% and 3% of contract value.

Return ONLY valid JSON, no markdown fences:
{"suggestion":[{"milestoneNumber":1,"suggestedDate":"YYYY-MM-DD","suggestedAmount":12345.00,"percentage":30.00,"description":"...","changeReason":"brief reason referencing historical pattern where relevant"}],"explanation":"2-3 sentence explanation of the optimization rationale referencing historical data","financialSavings":{"amount":15000.00,"currency":"${currency}","reasoning":"one sentence explaining what drives the saving"}}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function processLLMResult(llmResult, session, sessionId) {
  let reply = '';
  let milestones = session.milestones;
  let status = session.status;

  if (llmResult.type === 'tool_call' && llmResult.toolName === 'propose_milestones') {
    milestones = llmResult.toolInput.milestones;
    session.milestones = milestones;
    status = 'milestones_proposed';

    const conf     = llmResult.toolInput.confidence;
    const total    = llmResult.toolInput.totalAmount;
    const currency = llmResult.toolInput.currency;
    reply = `I have extracted ${milestones.length} billing milestones from the documents (confidence: ${conf}). ` +
            `Total contract value: ${currency} ${Number(total).toLocaleString('de-DE', { minimumFractionDigits: 2 })}. ` +
            `Please review the table below. If everything looks correct, click "Create in SAP S/4HANA". ` +
            `Otherwise, describe any corrections in the chat.`;

    // Inject tool_result so the next user message is a valid Anthropic API continuation
    session.conversationHistory.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: llmResult.toolUseId, tool_name: llmResult.toolName, content: 'Milestones have been proposed to the user.' }]
    });
  } else if (llmResult.text) {
    reply = llmResult.text;
  } else {
    console.error('[AgentService] Empty text from AI Core. llmResult:', JSON.stringify(llmResult));
    reply = 'The model returned an empty response. Please check the server logs and try again.';
  }

  session.status = status;
  return { sessionId, reply, milestones, status };
}

// ── CAP Service Implementation ────────────────────────────────────────────────

module.exports = cds.service.impl(async function (srv) {

  // ── Action: chat ──────────────────────────────────────────────────────────
  srv.on('chat', async (req) => {
    const { sessionId, message } = req.data;

    const session = sessionStore.get(sessionId);
    if (!session) {
      return req.error(404, `Session ${sessionId} not found. Please upload documents again.`);
    }

    session.conversationHistory.push({ role: 'user', content: message });

    let llmResult;
    try {
      llmResult = await aiCore.chat(session.conversationHistory);
    } catch (aiErr) {
      return req.error(503, `AI Core error: ${aiErr.message}`);
    }

    session.conversationHistory.push({ role: 'assistant', content: llmResult.rawContent });

    const responseData = processLLMResult(llmResult, session, sessionId);
    sessionStore.set(sessionId, session);

    return responseData;
  });

  // ── Action: createInSAP ───────────────────────────────────────────────────
  srv.on('createInSAP', async (req) => {
    const { sessionId } = req.data;

    const session = sessionStore.get(sessionId);
    if (!session) {
      return req.error(404, `Session ${sessionId} not found.`);
    }
    if (!session.milestones || session.milestones.length === 0) {
      return req.error(400, 'No milestones to create. Please upload documents and confirm the milestone table first.');
    }

    const sapPayloads = milestoneMapper.mapToSAPPayload(
      session.milestones,
      session.salesOrderId,
      null // billingPlan fetched dynamically by s4-client
    );

    let result;
    try {
      result = await s4Client.createAllMilestones(session.salesOrderId, sapPayloads);
    } catch (err) {
      return req.error(500, `SAP creation failed: ${err.message}`);
    }

    session.status = 'created';
    sessionStore.set(sessionId, session);

    return {
      success: true,
      message: `Successfully created ${result.count} billing plan item(s) for Sales Order ${session.salesOrderId} on Billing Plan ${result.billingPlanId}.`,
      created: result.count,
      billingPlan: result.billingPlanId
    };
  });

  // ── Action: predictDelayRisk ──────────────────────────────────────────────
  srv.on('predictDelayRisk', async (req) => {
    const { sessionId } = req.data;

    const session = sessionStore.get(sessionId);
    if (!session) return req.error(404, `Session ${sessionId} not found.`);
    if (!session.milestones || session.milestones.length === 0) {
      return req.error(400, 'No milestones available. Please complete the extraction flow first.');
    }

    const totalValue   = session.milestones.reduce((s, m) => s + Number(m.amount || 0), 0);
    const historical   = await getHistoricalPlans(totalValue);
    const prompt       = buildDelayRiskPrompt(session.milestones, historical);

    let raw;
    try {
      raw = await aiCore.suggestText(prompt);
    } catch (err) {
      return req.error(503, `AI Core error: ${err.message}`);
    }

    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed  = JSON.parse(cleaned);
      return { sessionId, risks: parsed.risks || [], summary: parsed.summary || '' };
    } catch (parseErr) {
      console.error('[predictDelayRisk] JSON parse error:', parseErr.message, '\nRaw:', raw);
      return req.error(500, 'Failed to parse AI response. Please try again.');
    }
  });

  // ── Action: updateMilestone ───────────────────────────────────────────────
  srv.on('updateMilestone', async (req) => {
    const { sessionId, milestoneNumber, field, value } = req.data;

    const ALLOWED_FIELDS = ['billingDate', 'amount', 'percentage', 'description', 'billingDocumentType'];
    if (!ALLOWED_FIELDS.includes(field)) {
      return req.error(400, `Field "${field}" is not editable.`);
    }

    const session = sessionStore.get(sessionId);
    if (!session) return req.error(404, `Session ${sessionId} not found.`);
    if (!session.milestones || session.milestones.length === 0) {
      return req.error(400, 'No milestones in session.');
    }

    const milestone = session.milestones.find(m => m.milestoneNumber === milestoneNumber);
    if (!milestone) return req.error(404, `Milestone #${milestoneNumber} not found.`);

    let coerced;
    if (field === 'billingDate') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value))) {
        return req.error(400, 'billingDate must be a valid date in YYYY-MM-DD format.');
      }
      coerced = value;
    } else if (field === 'amount') {
      const n = parseFloat(value);
      if (!isFinite(n) || n <= 0) return req.error(400, 'amount must be a positive number.');
      coerced = n;
    } else if (field === 'percentage') {
      const n = parseFloat(value);
      if (!isFinite(n) || n < 1 || n > 100) return req.error(400, 'percentage must be between 1 and 100.');
      coerced = n;
    } else if (field === 'description') {
      if (typeof value !== 'string' || value.length > 200) {
        return req.error(400, 'description must be 200 characters or less.');
      }
      coerced = value.trim();
    } else if (field === 'billingDocumentType') {
      if (!['FAZ', 'F2'].includes(value)) {
        return req.error(400, 'billingDocumentType must be FAZ or F2.');
      }
      coerced = value;
    }

    milestone[field] = coerced;
    sessionStore.set(sessionId, session);

    return { success: true, milestoneNumber, field, newValue: String(coerced) };
  });

  // ── Action: suggestOptimization ───────────────────────────────────────────
  srv.on('suggestOptimization', async (req) => {
    const { sessionId } = req.data;

    const session = sessionStore.get(sessionId);
    if (!session) return req.error(404, `Session ${sessionId} not found.`);
    if (!session.milestones || session.milestones.length === 0) {
      return req.error(400, 'No milestones available. Please complete the extraction flow first.');
    }

    const totalValue   = session.milestones.reduce((s, m) => s + Number(m.amount || 0), 0);
    const historical   = await getHistoricalPlans(totalValue);
    const prompt       = buildOptimizationPrompt(session.milestones, historical);

    let raw;
    try {
      raw = await aiCore.suggestText(prompt);
    } catch (err) {
      return req.error(503, `AI Core error: ${err.message}`);
    }

    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed  = JSON.parse(cleaned);
      return { sessionId, suggestion: parsed.suggestion || [], explanation: parsed.explanation || '', financialSavings: parsed.financialSavings || null };
    } catch (parseErr) {
      console.error('[suggestOptimization] JSON parse error:', parseErr.message, '\nRaw:', raw);
      return req.error(500, 'Failed to parse AI response. Please try again.');
    }
  });
}); // end cds.service.impl

