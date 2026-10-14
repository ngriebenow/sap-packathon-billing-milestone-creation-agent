'use strict';

const cds             = require('@sap/cds');
const sessionStore    = require('./lib/session-store');
const aiCore          = require('./lib/ai-core-client');
const milestoneMapper = require('./lib/milestone-mapper');
const s4Client        = require('./lib/s4-client');
const seedData        = require('../mock-s4/seed-data');

// ── Analytics prompt builders ─────────────────────────────────────────────────

function buildDelayRiskPrompt(milestones, historical) {
  return `You are a payment risk analyst for industrial machinery sales contracts.

Current billing milestones:
${JSON.stringify(milestones, null, 2)}

Historical billing plans from similar contracts (for reference):
${JSON.stringify(historical, null, 2)}

For each milestone, assess payment delay risk. Consider:
- Milestone type (down payment rarely late, final invoice often delayed)
- Due date proximity to Q4 (Oct–Dec budgets often frozen, delay risk higher)
- Historical late payment rates for similar milestone types
- Contract value (larger contracts tend to have more payment friction)

Return ONLY valid JSON, no markdown fences:
{"risks":[{"milestoneNumber":1,"description":"...","riskLevel":"low|medium|high","reasoning":"one sentence"}],"summary":"2-3 sentence overall risk summary"}`;
}

function buildOptimizationPrompt(milestones, historical) {
  const totalValue = milestones.reduce((s, m) => s + Number(m.amount || 0), 0);
  return `You are a billing plan optimization specialist for industrial machinery contracts.

Current billing milestones (total contract value: ${totalValue} ${milestones[0]?.currency || 'EUR'}):
${JSON.stringify(milestones, null, 2)}

Historical billing plans from similar contracts (for reference):
${JSON.stringify(historical, null, 2)}

Suggest an optimized billing plan structure that:
1. Improves the seller's cash flow (front-load payments where possible)
2. Aligns milestone dates with natural project phases
3. KEEPS the total contract value IDENTICAL (${totalValue} ${milestones[0]?.currency || 'EUR'})
4. Keeps the same number of milestones
5. Sets percentage=0 for the last (final invoice) milestone

Return ONLY valid JSON, no markdown fences:
{"suggestion":[{"milestoneNumber":1,"suggestedDate":"YYYY-MM-DD","suggestedAmount":12345.00,"percentage":30.00,"description":"...","changeReason":"brief reason"}],"explanation":"2-3 sentence explanation of the optimization rationale"}`;
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
    const historical   = seedData.getHistoricalPlans(totalValue);
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

  // ── Action: suggestOptimization ───────────────────────────────────────────
  srv.on('suggestOptimization', async (req) => {
    const { sessionId } = req.data;

    const session = sessionStore.get(sessionId);
    if (!session) return req.error(404, `Session ${sessionId} not found.`);
    if (!session.milestones || session.milestones.length === 0) {
      return req.error(400, 'No milestones available. Please complete the extraction flow first.');
    }

    const totalValue   = session.milestones.reduce((s, m) => s + Number(m.amount || 0), 0);
    const historical   = seedData.getHistoricalPlans(totalValue);
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
      return { sessionId, suggestion: parsed.suggestion || [], explanation: parsed.explanation || '' };
    } catch (parseErr) {
      console.error('[suggestOptimization] JSON parse error:', parseErr.message, '\nRaw:', raw);
      return req.error(500, 'Failed to parse AI response. Please try again.');
    }
  });
});
