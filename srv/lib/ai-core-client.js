'use strict';

const fetch = require('node-fetch');
const { TOOLS } = require('./milestone-tools');

const AICORE_MODEL          = () => process.env.AICORE_MODEL          || 'gemini-2.5-pro';
const AICORE_BASE_URL       = () => process.env.AICORE_BASE_URL;
const AICORE_CLIENT_ID      = () => process.env.AICORE_CLIENT_ID;
const AICORE_CLIENT_SECRET  = () => process.env.AICORE_CLIENT_SECRET;
const AICORE_TOKEN_URL      = () => process.env.AICORE_TOKEN_URL;
const AICORE_RESOURCE_GROUP = () => process.env.AICORE_RESOURCE_GROUP || 'default';

// ── OAuth token cache ─────────────────────────────────────────────────────────
let cachedToken    = null;
let tokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

  const tokenUrl     = AICORE_TOKEN_URL();
  const clientId     = AICORE_CLIENT_ID();
  const clientSecret = AICORE_CLIENT_SECRET();

  if (!tokenUrl || tokenUrl.includes('<your-') || !clientId || clientId.includes('<your-')) {
    throw new Error(
      'AI Core OAuth credentials are not configured. ' +
      'Set AICORE_CLIENT_ID, AICORE_CLIENT_SECRET, and AICORE_TOKEN_URL in your .env file.'
    );
  }

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret
    })
  });

  if (!res.ok) {
    throw new Error(`AI Core token fetch failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken    = data.access_token;
  tokenExpiresAt = now + (data.expires_in ?? 43200) * 1000;
  console.log(`[AI Core] Token refreshed, valid for ${Math.round((tokenExpiresAt - now) / 60000)} min`);
  return cachedToken;
}

// ── Prompt / format helpers ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a billing milestone extraction specialist for SAP S/4HANA billing plans.

Your task is to analyze sales contract documents and extract all billing milestones precisely.

Rules:
1. A billing milestone has: a sequential number (starting at 1), a billing date, an absolute amount, a percentage of total, and a currency.
2. The LAST milestone is always a final invoice (billing type F2). All others are advance invoices (FAZ).
3. The final milestone represents the full contract total. Its percentage in SAP is always 0 — do not guess a percentage for it.
4. Dates must be in ISO 8601 format: YYYY-MM-DD.
5. All milestone amounts and percentages must be consistent with the total contract value.
6. If you are uncertain about ANY date, amount, percentage, or interpretation — ask the user a specific clarifying question in plain text. Do NOT call the propose_milestones tool when uncertain.
7. When you have all information with confidence, call the propose_milestones tool.
8. If the user provides corrections, update your understanding and call propose_milestones again with the corrected data.
9. Look for payment schedules, installment plans, project milestones, and delivery-based payment terms in the documents.`;

/**
 * Converts our internal conversation history (Anthropic-style) to Gemini `contents` format.
 * Handles plain strings, text blocks, tool_use blocks, and tool_result blocks.
 */
function toGeminiContents(conversationHistory) {
  const rawContents = [];

  for (const msg of conversationHistory) {
    const { role, content } = msg;
    const geminiRole = role === 'assistant' ? 'model' : 'user';

    if (typeof content === 'string') {
      rawContents.push({ role: geminiRole, parts: [{ text: content }] });
      continue;
    }

    if (Array.isArray(content)) {
      const parts = [];
      for (const block of content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'inlineData') {
          parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
        } else if (block.type === 'tool_use') {
          parts.push({ functionCall: { name: block.name, args: block.input } });
        } else if (block.type === 'tool_result') {
          // Gemini requires functionResponse.name to match the original functionCall.name
          parts.push({
            functionResponse: {
              name:     block.tool_name || block.tool_use_id,
              response: { content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
            }
          });
        }
      }
      if (parts.length > 0) rawContents.push({ role: geminiRole, parts });
    }
  }

  // Gemini requires strict user/model alternation — merge consecutive same-role turns
  const contents = [];
  for (const turn of rawContents) {
    const prev = contents[contents.length - 1];
    if (prev && prev.role === turn.role) {
      // Merge parts into the previous turn
      prev.parts.push(...turn.parts);
    } else {
      contents.push({ role: turn.role, parts: [...turn.parts] });
    }
  }

  return contents;
}

/**
 * Converts our Anthropic-style TOOLS schema to Gemini function declarations.
 */
function toGeminiTools(tools) {
  return [{
    functionDeclarations: tools.map(t => ({
      name:        t.name,
      description: t.description,
      parameters:  t.input_schema
    }))
  }];
}

// ── Main chat function ────────────────────────────────────────────────────────

/**
 * Calls SAP AI Core (Gemini via Vertex-compatible endpoint).
 * SAP AI Core foundation-models scenario for Gemini uses the path:
 *   POST <deploymentUrl>/models/<model>:generateContent
 *
 * Returns:
 *   { type: 'tool_call', toolName, toolInput, rawContent, toolUseId }
 *   { type: 'text', text, rawContent }
 */
async function chat(conversationHistory) {
  const baseUrl = AICORE_BASE_URL();
  if (!baseUrl || baseUrl.includes('<your-')) {
    throw new Error('AICORE_BASE_URL is not configured. Please set it in your .env file.');
  }

  const token = await getToken();
  const model = AICORE_MODEL();

  const geminiContents = toGeminiContents(conversationHistory);
  console.log('[AI Core] Sending %d turns:', geminiContents.length,
    geminiContents.map(t => `${t.role}:[${t.parts.map(p => Object.keys(p)[0]).join(',')}]`).join(' → '));

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents:           geminiContents,
    tools:              toGeminiTools(TOOLS),
    tool_config:        { function_calling_config: { mode: 'AUTO' } },
    generationConfig:   { maxOutputTokens: 8192 }
  };

  const url = `${baseUrl}/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'AI-Resource-Group': AICORE_RESOURCE_GROUP(),
      'Authorization':     `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI Core error ${response.status}: ${errText}`);
  }

  const data = await response.json();

  const candidate   = data.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const parts        = candidate?.content?.parts ?? [];

  console.log(`[AI Core] finishReason=${finishReason} parts=${JSON.stringify(parts.map(p => Object.keys(p)))}`);

  // Gemini sometimes returns finishReason without content (SAFETY, RECITATION, etc.)
  if (!candidate?.content && finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
    throw new Error(`Gemini stopped with finishReason=${finishReason} and no content.`);
  }

  // Prefer functionCall if present (may coexist with a text part)
  const fnCallPart = parts.find(p => p.functionCall);
  if (fnCallPart) {
    const fc = fnCallPart.functionCall;
    const toolUseId = `gemini-fn-${Date.now()}`;

    const rawContent = [{
      type:  'tool_use',
      id:    toolUseId,
      name:  fc.name,
      input: fc.args ?? {}
    }];

    return {
      type:      'tool_call',
      toolName:  fc.name,
      toolInput: fc.args ?? {},
      toolUseId,
      rawContent
    };
  }

  // Plain text response — collect all text parts (ignore thoughtSignature and other non-text parts)
  const text = parts.filter(p => typeof p.text === 'string').map(p => p.text).join('');

  if (!text) {
    console.warn('[AI Core] Empty text. Full response: %s', JSON.stringify(data));
  }

  return {
    type:       'text',
    text,
    rawContent: [{ type: 'text', text }]
  };
}

// ── suggestText — lightweight single-turn call (no tools) ────────────────────

/**
 * Single-turn Gemini call for structured JSON output (SO suggestion, analytics).
 * Returns the raw text string from the model response.
 */
async function suggestText(prompt) {
  const baseUrl = AICORE_BASE_URL();
  if (!baseUrl || baseUrl.includes('<your-')) {
    throw new Error('AICORE_BASE_URL is not configured. Please set it in your .env file.');
  }

  const token = await getToken();
  const model = AICORE_MODEL();

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1024, temperature: 0.1 }
  };

  const url = `${baseUrl}/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'AI-Resource-Group': AICORE_RESOURCE_GROUP(),
      'Authorization':     `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI Core suggestText error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts.filter(p => typeof p.text === 'string').map(p => p.text).join('');
}

module.exports = { chat, getToken, suggestText, SYSTEM_PROMPT };
