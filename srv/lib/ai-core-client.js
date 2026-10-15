'use strict';

const fetch = require('node-fetch');
const { TOOLS } = require('./milestone-tools');

const AICORE_PROVIDER       = () => (process.env.AICORE_PROVIDER || 'gemini').toLowerCase();
const IS_CLAUDE             = () => AICORE_PROVIDER() === 'claude';
const AICORE_BASE_URL       = () => IS_CLAUDE()
  ? process.env.AICORE_BASE_URL_CLAUDE
  : (process.env.AICORE_BASE_URL_GEMINI || process.env.AICORE_BASE_URL);
const AICORE_MODEL          = () => IS_CLAUDE()
  ? (process.env.AICORE_MODEL_CLAUDE || 'claude-opus-4-8')
  : (process.env.AICORE_MODEL_GEMINI || process.env.AICORE_MODEL || 'gemini-2.5-pro');
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
2. Extract ALL payment milestones from the contract exactly as described — including the final acceptance or commissioning payment. All milestones are advance payments (FAZ).
3. The percentages of all milestones must add up to 100% of the total contract value. Include every payment step, even the last one.
4. Dates must be in ISO 8601 format: YYYY-MM-DD.
5. All milestone amounts must be consistent with the total contract value. Each percentage reflects that payment's share of the total.
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
 * Converts our internal conversation history to Anthropic Messages API format.
 */
function toAnthropicMessages(conversationHistory) {
  return conversationHistory.map(msg => {
    const { role, content } = msg;
    if (typeof content === 'string') {
      return { role, content: [{ type: 'text', text: content }] };
    }
    if (Array.isArray(content)) {
      const blocks = content.map(block => {
        if (block.type === 'text')       return { type: 'text', text: block.text };
        if (block.type === 'inlineData') {
          const isImage = ['image/jpeg','image/png','image/gif','image/webp'].includes(block.mimeType);
          return isImage
            ? { type: 'image',    source: { type: 'base64', media_type: block.mimeType, data: block.data } }
            : { type: 'document', source: { type: 'base64', media_type: block.mimeType, data: block.data } };
        }
        if (block.type === 'tool_use')   return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        if (block.type === 'tool_result') return { type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content };
        return null;
      }).filter(Boolean);
      return { role, content: blocks };
    }
    return { role, content: [] };
  });
}

/**
 * Converts our Anthropic-style TOOLS schema to Anthropic API tool format.
 */
function toAnthropicTools(tools) {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
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
 * Calls SAP AI Core with either Gemini or Claude depending on AICORE_MODEL.
 * Gemini: POST <baseUrl>/models/<model>:generateContent
 * Claude: POST <baseUrl>/models/<model>:invoke  (Anthropic Messages API format)
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

  if (IS_CLAUDE()) {
    // ── Claude via SAP AI Core (/invoke, Anthropic Messages API) ──────────
    // SAP AI Core determines the model from the deployment URL — no `model`
    // field in the body. anthropic_version is required in the body.
    const messages = toAnthropicMessages(conversationHistory);
    console.log('[AI Core/Claude] Sending %d messages', messages.length);

    const body = {
      anthropic_version: '2023-06-01',
      max_tokens:        8192,
      system:            SYSTEM_PROMPT,
      messages,
      tools:             toAnthropicTools(TOOLS),
      tool_choice:       { type: 'auto' },
    };

    const url = `${baseUrl}/invoke`;
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
      throw new Error(`AI Core (Claude) error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const content = data.content ?? [];
    console.log(`[AI Core/Claude] stop_reason=${data.stop_reason} blocks=${content.map(b => b.type).join(',')}`);

    const toolBlock = content.find(b => b.type === 'tool_use');
    if (toolBlock) {
      const rawContent = [{ type: 'tool_use', id: toolBlock.id, name: toolBlock.name, input: toolBlock.input }];
      return { type: 'tool_call', toolName: toolBlock.name, toolInput: toolBlock.input, toolUseId: toolBlock.id, rawContent };
    }

    const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    return { type: 'text', text, rawContent: [{ type: 'text', text }] };

  } else {
    // ── Gemini via Vertex-compatible endpoint ──────────────────────────────
    const geminiContents = toGeminiContents(conversationHistory);
    console.log('[AI Core/Gemini] Sending %d turns:', geminiContents.length,
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

    console.log(`[AI Core/Gemini] finishReason=${finishReason} parts=${JSON.stringify(parts.map(p => Object.keys(p)))}`);

    if (!candidate?.content && finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
      throw new Error(`Gemini stopped with finishReason=${finishReason} and no content.`);
    }

    const fnCallPart = parts.find(p => p.functionCall);
    if (fnCallPart) {
      const fc = fnCallPart.functionCall;
      const toolUseId = `gemini-fn-${Date.now()}`;
      const rawContent = [{ type: 'tool_use', id: toolUseId, name: fc.name, input: fc.args ?? {} }];
      return { type: 'tool_call', toolName: fc.name, toolInput: fc.args ?? {}, toolUseId, rawContent };
    }

    const text = parts.filter(p => typeof p.text === 'string').map(p => p.text).join('');
    if (!text) console.warn('[AI Core/Gemini] Empty text. Full response: %s', JSON.stringify(data));
    return { type: 'text', text, rawContent: [{ type: 'text', text }] };
  }
}

// ── suggestText — lightweight single-turn call (no tools) ────────────────────

/**
 * Single-turn call for structured JSON output (SO suggestion, analytics).
 * Supports both Gemini (:generateContent) and Claude (:invoke).
 * Returns the raw text string from the model response.
 */
async function suggestText(prompt) {
  const baseUrl = AICORE_BASE_URL();
  if (!baseUrl || baseUrl.includes('<your-')) {
    throw new Error('AICORE_BASE_URL is not configured. Please set it in your .env file.');
  }

  const token = await getToken();
  const model = AICORE_MODEL();

  if (IS_CLAUDE()) {
    const body = {
      anthropic_version: '2023-06-01',
      max_tokens: 4096,
      messages:   [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    };

    const url = `${baseUrl}/invoke`;
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
      throw new Error(`AI Core (Claude) suggestText error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');

  } else {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.1 }
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
}

module.exports = { chat, getToken, suggestText, SYSTEM_PROMPT };
