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

// Derive analytics payload from milestones. contractTotal comes from session.target.amount.
// All milestones are FAZ advance payments — no F2 sentinel.
function analyticsPayload(milestones, contractTotal) {
  const currency = milestones[0]?.currency || 'EUR';
  const fazSum   = milestones.reduce((s, m) => s + Number(m.amount || 0), 0);
  const payments = milestones.map(m => ({
    id:          m.milestoneNumber,
    date:        m.billingDate,
    amount:      Number(m.amount || 0),
    description: m.description || '',
  }));
  return { contractTotal, currency, fazSum, payments };
}

function historicalPayments(plans) {
  return plans.map(plan => {
    const f2    = (plan.milestones || []).find(i => i.docType === 'F2');
    const total = Number(plan.contractValue || (f2 && f2.amount) || 0);
    const faz   = (plan.milestones || []).filter(i => i.docType !== 'F2');
    return {
      contractValue:   total,
      currency:        plan.currency,
      customerCountry: plan.customerCountry,
      incoterms:       plan.incoterms,
      paymentTerms:    plan.paymentTerms,
      payments:        faz.map(i => ({
        date:        i.billingDate || i._billingDateISO,
        amount:      Number(i.amount || 0),
        pctOfTotal:  total > 0 ? Math.round(Number(i.amount || 0) / total * 1000) / 10 : 0,
      })),
    };
  });
}

function buildDelayRiskPrompt(milestones, historical, contractTotal) {
  const { currency, fazSum, payments } = analyticsPayload(milestones, contractTotal);
  const hist = historicalPayments(historical);
  const remainder = contractTotal - fazSum;

  return `You are a payment risk analyst for industrial machinery sales contracts.

You are given a list of ADVANCE PAYMENTS for a contract worth ${contractTotal.toLocaleString('de-DE')} ${currency}.
These are the actual invoices sent to the customer before project completion.
After all advance payments, a final closing invoice collects the remaining ${remainder.toLocaleString('de-DE')} ${currency}.

Advance payment schedule:
${JSON.stringify(payments, null, 2)}

Historical advance payment schedules from real contracts with similar values:
${JSON.stringify(hist, null, 2)}

Assess payment delay risk for each advance payment. Consider:
- Date proximity to Q4 (Oct–Dec budgets often frozen)
- Payment terms from historical data
- How much of the contract is secured before final delivery
- Historical patterns for similar contract sizes

Return ONLY valid JSON, no markdown fences:
{"risks":[{"milestoneNumber":1,"description":"...","riskLevel":"low|medium|high","reasoning":"one sentence"}],"summary":"2-3 sentence overall assessment"}`;
}

function buildOptimizationPrompt(milestones, historical, contractTotal) {
  const { currency, fazSum, payments } = analyticsPayload(milestones, contractTotal);
  const hist = historicalPayments(historical);
  const remainder = contractTotal - fazSum;

  // List current payments with their share of the advance total for reference
  const paymentsWithPct = payments.map(p => ({
    ...p,
    pct_of_advances: fazSum > 0 ? Math.round(p.amount / fazSum * 1000) / 10 : 0,
  }));

  return `You are a cash-flow optimisation specialist for industrial machinery contracts.

CONTRACT FACTS (do not change these):
- Total contract value: ${contractTotal.toLocaleString('de-DE')} ${currency}
- Number of advance payments: ${payments.length}
- Sum of all advance payments: ${fazSum.toLocaleString('de-DE')} ${currency}  ← THIS TOTAL MUST NOT CHANGE
- Remaining closing payment (fixed, not part of your output): ${remainder.toLocaleString('de-DE')} ${currency}

CURRENT ADVANCE PAYMENT SCHEDULE:
${JSON.stringify(paymentsWithPct, null, 2)}

TASK: Suggest a new advance payment schedule with the SAME ${payments.length} payments that STILL SUM TO EXACTLY ${fazSum.toLocaleString('de-DE')} ${currency}.
You may only change the dates and the split of amounts between payments.
Do NOT add or remove payments. Do NOT change the total.

Optimise for:
1. Earlier receipt of cash (front-load where possible, matching historical best practice below)
2. Milestone dates aligned to typical project phases in similar contracts

Historical advance payment patterns from real contracts with similar contract values:
${JSON.stringify(hist, null, 2)}

Estimate financial savings from earlier cash receipt: assume 4% annual cost of capital and typical 2% late-payment penalty. Be conservative — realistic savings are 0.5%–3% of the ${contractTotal.toLocaleString('de-DE')} ${currency} contract value.

Return ONLY valid JSON, no markdown fences. The "suggestion" array must have exactly ${payments.length} entries and their suggestedAmount values must sum to exactly ${fazSum.toLocaleString('de-DE')} ${currency}:
{"suggestion":[{"milestoneNumber":1,"suggestedDate":"YYYY-MM-DD","suggestedAmount":12345.00,"description":"...","changeReason":"brief reason"}],"explanation":"2-3 sentence rationale","financialSavings":{"amount":15000.00,"currency":"${currency}","reasoning":"one sentence"}}`;
}

function buildOptimizationPromptWithInstruction(milestones, historical, contractTotal, userInstruction) {
  const base = buildOptimizationPrompt(milestones, historical, contractTotal);
  return base + `\n\nADDITIONAL INSTRUCTION FROM USER: ${userInstruction}\nApply this instruction on top of the general optimisation goals above.`;
}

function processLLMResult(llmResult, session, sessionId) {
  let reply = '';
  let milestones = session.milestones;
  let status = session.status;

  if (llmResult.type === 'tool_call' && llmResult.toolName === 'propose_milestones') {
    const rawMs = llmResult.toolInput.milestones;
    milestones = rawMs.map(m => ({ ...m, billingDocumentType: 'FAZ' }));
    session.milestones = milestones;
    session.target = {
      amount:     Number(llmResult.toolInput.totalAmount || 0),
      currency:   llmResult.toolInput.currency || (rawMs[0]?.currency ?? 'EUR'),
      percentage: 100,
    };
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
  return { sessionId, reply, milestones, target: session.target || null, status };
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

    // If the extraction LLM returned plain text (not a new tool call) and the
    // session already has milestones, also run the optimizer with the user's
    // message as an additional constraint so the chat can drive the optimized plan.
    if (llmResult.type === 'text' && session.milestones && session.milestones.length > 0) {
      try {
        const contractTotal = session.target?.amount || analyticsPayload(session.milestones, 0).fazSum;
        const historical    = await getHistoricalPlans(contractTotal);
        const prompt        = buildOptimizationPromptWithInstruction(session.milestones, historical, contractTotal, message);
        const raw           = await aiCore.suggestText(prompt);
        const cleaned       = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        const parsed        = JSON.parse(cleaned);

        const { fazSum }   = analyticsPayload(session.milestones, contractTotal);
        const modelItems   = parsed.suggestion || [];
        const modelSum     = modelItems.reduce((s, m) => s + Number(m.suggestedAmount || 0), 0);
        const scale        = modelSum > 0 ? fazSum / modelSum : 1;
        const suggestion   = modelItems
          .map(m => ({
            ...m,
            billingDocumentType: 'FAZ',
            suggestedAmount: Math.round(Number(m.suggestedAmount || 0) * scale * 100) / 100,
          }))
          .sort((a, b) => a.milestoneNumber - b.milestoneNumber);

        responseData.suggestion      = suggestion;
        responseData.explanation     = parsed.explanation || '';
        responseData.financialSavings = parsed.financialSavings || null;
      } catch (optErr) {
        console.warn('[chat] Optimization step failed (non-fatal):', optErr.message);
      }
    }

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

    const contractTotal = session.target?.amount || analyticsPayload(session.milestones, 0).fazSum;
    const historical   = await getHistoricalPlans(contractTotal);
    const prompt       = buildDelayRiskPrompt(session.milestones, historical, contractTotal);

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

    const contractTotal = session.target?.amount || analyticsPayload(session.milestones, 0).fazSum;
    const historical    = await getHistoricalPlans(contractTotal);
    const prompt        = buildOptimizationPrompt(session.milestones, historical, contractTotal);

    let raw;
    try {
      raw = await aiCore.suggestText(prompt);
    } catch (err) {
      return req.error(503, `AI Core error: ${err.message}`);
    }

    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed  = JSON.parse(cleaned);

      const { fazSum } = analyticsPayload(session.milestones, contractTotal);

      // Rescale model output proportionally so FAZ amounts always sum to the original pool.
      const modelItems  = parsed.suggestion || [];
      const modelSum    = modelItems.reduce((s, m) => s + Number(m.suggestedAmount || 0), 0);
      const scale       = modelSum > 0 ? fazSum / modelSum : 1;
      const suggestion  = modelItems
        .map(m => ({
          ...m,
          billingDocumentType: 'FAZ',
          suggestedAmount: Math.round(Number(m.suggestedAmount || 0) * scale * 100) / 100,
        }))
        .sort((a, b) => a.milestoneNumber - b.milestoneNumber);

      return {
        sessionId,
        suggestion,
        explanation:     parsed.explanation || '',
        financialSavings: parsed.financialSavings || null,
        target:          session.target || null,
      };
    } catch (parseErr) {
      console.error('[suggestOptimization] JSON parse error:', parseErr.message, '\nRaw:', raw);
      return req.error(500, 'Failed to parse AI response. Please try again.');
    }
  });
}); // end cds.service.impl

