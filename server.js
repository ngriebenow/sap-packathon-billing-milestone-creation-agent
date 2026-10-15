'use strict';

require('dotenv').config();

const cds          = require('@sap/cds');
const multer       = require('multer');
const cookieParser = require('cookie-parser');
const express      = require('express');
const path         = require('path');
const { v4: uuidv4 } = require('uuid');

const upload = multer({ storage: multer.memoryStorage() });

function getSessionStore() { return require('./srv/lib/session-store'); }
function getDocReader()    { return require('./srv/lib/pdf-extractor'); }
function getAiCoreClient() { return require('./srv/lib/ai-core-client'); }

// ── SO Suggestion helpers ────────────────────────────────────────────────────

function buildSuggestPrompt(fileNames, catalog) {
  const catalogJson = JSON.stringify(catalog.slice(0, 100));
  return `You are a sales order matching assistant. Given a list of uploaded filenames and a catalog of sales orders, identify the best-matching sales orders.

Uploaded filenames: ${JSON.stringify(fileNames)}

Sales order catalog (JSON):
${catalogJson}

Match rules:
- Look for customer name hints, project keywords (CNC, robot, press, lathe, grind, weld, laser, hydraulic, milling, cobot, gear, EDM, plasma, AGV, ultrasonic), embedded order numbers, or date suffixes in the filenames.
- Rank by confidence: high = strong keyword or number match, medium = partial keyword match, low = weak signal.
- Return up to 3 matches. If there are no plausible matches return an empty array.

IMPORTANT: Return ONLY a JSON array, no markdown fences, no explanation:
[{"salesOrderId":"40000001","customerName":"...","projectName":"...","confidence":"high|medium|low"}]`;
}

cds.on('bootstrap', (app) => {
  app.use(cookieParser());
  app.use('/resources', express.static(path.join(__dirname, 'resources')));

  app.post('/upload', upload.array('files'), async (req, res) => {
    const sessionStore = getSessionStore();
    const docReader    = getDocReader();
    const aiCore       = getAiCoreClient();

    try {
      let sid = req.headers['x-session-id'] || req.cookies?.sessionId;
      if (!sid) sid = uuidv4();
      res.cookie('sessionId', sid, { httpOnly: true, sameSite: 'Strict' });

      const salesOrderId = req.body.salesOrderId;
      if (!salesOrderId) {
        return res.status(400).json({ error: 'salesOrderId is required' });
      }
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'At least one document file is required' });
      }

      // Build a multipart first message: one inlineData part per file + a text instruction
      const docParts = req.files.map(file => {
        const doc = docReader.prepareDocument(file.buffer, file.mimetype, file.originalname);
        return { type: 'inlineData', mimeType: doc.mimeType, data: doc.data, originalname: doc.originalname };
      });

      const fileNames = req.files.map(f => f.originalname).join(', ');
      const initialContent = [
        ...docParts,
        {
          type: 'text',
          text: `Please analyze the above sales contract document(s) and extract all billing milestones.\n\n` +
                `Files: ${fileNames}\nSales Order ID: ${salesOrderId}`
        }
      ];

      const session = {
        salesOrderId,
        conversationHistory: [{ role: 'user', content: initialContent }],
        milestones: null,
        status: 'chatting'
      };
      sessionStore.set(sid, session);

      let llmResult;
      try {
        llmResult = await aiCore.chat(session.conversationHistory);
      } catch (aiErr) {
        if (aiErr.message.includes('not configured')) {
          return res.json({
            sessionId: sid,
            reply: `**AI Core is not yet configured.** Set credentials in your .env file.\n\n` +
                   `Session created (${sid.slice(0,8)}…), ${req.files.length} document(s) received for Sales Order ${salesOrderId}.`,
            milestones: null,
            status: 'chatting'
          });
        }
        throw aiErr;
      }

      session.conversationHistory.push({ role: 'assistant', content: llmResult.rawContent });

      let reply = '';
      let milestones = null;
      let status = 'chatting';

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

        session.conversationHistory.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: llmResult.toolUseId, tool_name: llmResult.toolName, content: 'Milestones have been proposed to the user.' }]
        });
      } else {
        reply = llmResult.text || 'I could not extract milestones. Please try again.';
      }

      session.status = status;
      sessionStore.set(sid, session);

      res.json({ sessionId: sid, reply, milestones, target: session.target || null, status });
    } catch (err) {
      console.error('[Upload] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/suggestSalesOrder ─────────────────────────────────────────
  app.post('/api/suggestSalesOrder', express.json(), async (req, res) => {
    const aiCore   = getAiCoreClient();
    const mockHost = process.env.S4_BASE_URL
      ? process.env.S4_BASE_URL.replace('/sap/opu/odata/sap/API_SALES_ORDER_SRV', '')
      : `http://localhost:${process.env.MOCK_S4_PORT || 3001}`;

    const fileNames = req.body.fileNames;
    if (!Array.isArray(fileNames) || fileNames.length === 0) {
      return res.status(400).json({ error: 'fileNames array is required' });
    }

    try {
      // Fetch SO catalog from mock server
      const fetch = require('node-fetch');
      const catalogRes = await fetch(`${mockHost}/api/salesOrders`);
      if (!catalogRes.ok) throw new Error(`Catalog fetch failed: ${catalogRes.status}`);
      const catalog = await catalogRes.json();

      const prompt = buildSuggestPrompt(fileNames, catalog);
      const raw    = await aiCore.suggestText(prompt);

      // Strip markdown code fences if present
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const suggestions = JSON.parse(cleaned);
      return res.json({ suggestions: Array.isArray(suggestions) ? suggestions.slice(0, 3) : [] });
    } catch (err) {
      console.error('[SuggestSalesOrder] Error:', err.message);
      return res.json({ suggestions: [] });
    }
  });

  // ── POST /api/devMockSession — dev shortcut, seeds a fake session instantly ──
  app.post('/api/devMockSession', express.json(), (req, res) => {
    const sessionStore = getSessionStore();
    const { v4: uuidv4 } = require('uuid');
    const sid = uuidv4();

    const milestones = [
      { milestoneNumber: 1, billingDate: '2026-03-01', amount: 87500,  percentage: 25, currency: 'EUR', description: 'Down payment',                       billingDocumentType: 'FAZ' },
      { milestoneNumber: 2, billingDate: '2026-06-15', amount: 105000, percentage: 30, currency: 'EUR', description: 'Design approval & engineering freeze', billingDocumentType: 'FAZ' },
      { milestoneNumber: 3, billingDate: '2026-09-30', amount: 87500,  percentage: 25, currency: 'EUR', description: 'Factory acceptance test (FAT)',        billingDocumentType: 'FAZ' },
    ];
    const target = { amount: 350000, currency: 'EUR', percentage: 100 };

    const session = {
      salesOrderId: 'DEV-M80550',
      milestones,
      target,
      status: 'milestones_proposed',
      conversationHistory: [
        { role: 'user',      content: '[dev mock session]' },
        { role: 'assistant', content: '[mock milestones proposed]' },
      ],
    };
    sessionStore.set(sid, session);

    console.log(`[DevMock] Session ${sid} seeded with ${milestones.length} milestones + target`);
    res.json({
      sessionId:   sid,
      salesOrderId: session.salesOrderId,
      milestones,
      target,
      status:      'milestones_proposed',
      reply:       `**[Dev Mock]** Loaded ${milestones.length} hardcoded FAZ milestones for Sales Order DEV-M80550. Contract total: EUR 350,000.00. Click **Analytics** to test the chart, or edit cells directly.`,
    });
  });
});

module.exports = cds.server;
