// ---------------------------------------------------------------------------
// OpenBrowserClaw — GitHub Copilot Proxy Server
// ---------------------------------------------------------------------------
//
// Translates Anthropic Messages API → OpenAI Chat Completions API
// and proxies through GitHub Copilot's backend.
//
// Auth flow:
//   1. User provides a GitHub token (PAT or from `gh auth token`)
//   2. Server exchanges it for a Copilot JWT via api.github.com
//   3. Uses JWT to call api.githubcopilot.com/chat/completions
//   4. Translates response back to Anthropic format
//
// Usage:
//   POST /v1/messages          — Anthropic-compatible endpoint
//   POST /auth/github-token    — Set GitHub token
//   GET  /auth/status          — Check auth status
//   GET  /health               — Health check

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import os from 'os';
import {
  isResponsesModel,
  mapModelToCopilot,
  anthropicToOpenAI,
  anthropicToResponsesAPI,
  responsesAPIToAnthropic,
  openAIToAnthropic,
} from './translations.js';

const app = express();
const PORT = parseInt(process.env.PROXY_PORT || '3456', 10);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface CopilotToken {
  token: string;
  expires_at: number;
  refresh_in: number;
  chat_enabled: boolean;
}

let githubToken: string = process.env.GITHUB_TOKEN || '';
let copilotToken: CopilotToken | null = null;

const COPILOT_CHAT_URL = 'https://api.githubcopilot.com/chat/completions';
const COPILOT_RESPONSES_URL = 'https://api.githubcopilot.com/responses';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

// ---------------------------------------------------------------------------
// Machine ID (matches Copilot's fingerprinting)
// ---------------------------------------------------------------------------

function getMachineId(): string {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const info of iface) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
        return crypto.createHash('sha256').update(info.mac, 'utf8').digest('hex');
      }
    }
  }
  return crypto.randomUUID();
}

const machineId = getMachineId();

// ---------------------------------------------------------------------------
// Copilot Token Management
// ---------------------------------------------------------------------------

async function refreshCopilotToken(): Promise<void> {
  if (!githubToken) throw new Error('No GitHub token configured');

  console.log('[proxy] Exchanging GitHub token for Copilot JWT...');

  const res = await fetch(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: {
      'Authorization': `token ${githubToken}`,
      'Accept': 'application/json',
      'Editor-Version': 'vscode/1.90.0',
      'Editor-Plugin-Version': 'copilot-chat/0.12.0',
      'User-Agent': 'GitHubCopilotChat/0.12.0',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    copilotToken = null;
    throw new Error(`Copilot token exchange failed (${res.status}): ${body}`);
  }

  copilotToken = await res.json() as CopilotToken;
  console.log(`[proxy] Copilot token obtained (expires_at: ${copilotToken.expires_at}, chat_enabled: ${copilotToken.chat_enabled})`);
}

async function getCopilotJWT(): Promise<string> {
  // Refresh if expired or about to expire (60s buffer)
  if (!copilotToken || (Date.now() / 1000) >= copilotToken.expires_at - 60) {
    await refreshCopilotToken();
  }
  return copilotToken!.token;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    hasGithubToken: !!githubToken,
    hasCopilotToken: !!copilotToken,
    copilotTokenExpiry: copilotToken?.expires_at
      ? new Date(copilotToken.expires_at * 1000).toISOString()
      : null,
  });
});

// Auth status
app.get('/auth/status', async (_req, res) => {
  try {
    if (!githubToken) {
      return res.json({ authenticated: false, reason: 'No GitHub token' });
    }
    // Try to get/refresh the Copilot token
    await getCopilotJWT();
    res.json({
      authenticated: true,
      copilotExpiry: copilotToken?.expires_at
        ? new Date(copilotToken.expires_at * 1000).toISOString()
        : null,
      chatEnabled: copilotToken?.chat_enabled ?? false,
    });
  } catch (err: any) {
    res.json({ authenticated: false, reason: err.message });
  }
});

// Set GitHub token
app.post('/auth/github-token', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Missing "token" in request body' });
  }

  githubToken = token.trim();
  copilotToken = null; // Force refresh

  try {
    await getCopilotJWT();
    res.json({
      success: true,
      chatEnabled: copilotToken?.chat_enabled ?? false,
    });
  } catch (err: any) {
    githubToken = '';
    res.status(401).json({ error: err.message });
  }
});

// Main proxy endpoint — Anthropic Messages API compatible
app.post('/v1/messages', async (req, res) => {
  try {
    if (!githubToken) {
      return res.status(401).json({
        type: 'error',
        error: { type: 'authentication_error', message: 'No GitHub token configured. Go to Settings to add your token.' },
      });
    }

    const originalModel = req.body.model || 'claude-sonnet-4-6';
    const copilotModel = mapModelToCopilot(originalModel);
    const useResponsesAPI = isResponsesModel(copilotModel);

    const jwt = await getCopilotJWT();

    if (useResponsesAPI) {
      // ---- Codex models: use /responses endpoint ----
      const responsesBody = anthropicToResponsesAPI(req.body);

      console.log(`[proxy] ${originalModel} → ${responsesBody.model} (Responses API) | input_items: ${responsesBody.input.length} | tools: ${responsesBody.tools?.length ?? 0}`);

      const copilotRes = await fetch(COPILOT_RESPONSES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
          'X-Request-Id': crypto.randomUUID(),
          'Machine-Id': machineId,
          'User-Agent': 'GitHubCopilotChat/0.12.0',
          'Editor-Version': 'vscode/1.90.0',
          'Editor-Plugin-Version': 'copilot-chat/0.12.0',
          'Openai-Organization': 'github-copilot',
          'Copilot-Integration-Id': 'vscode-chat',
        },
        body: JSON.stringify(responsesBody),
      });

      if (!copilotRes.ok) {
        const errText = await copilotRes.text();
        console.error(`[proxy] Responses API error ${copilotRes.status}: ${errText}`);
        return res.status(copilotRes.status).json({
          type: 'error',
          error: {
            type: 'api_error',
            message: `Copilot Responses API error (${copilotRes.status}): ${errText}`,
          },
        });
      }

      const copilotResult = await copilotRes.json();
      const anthropicResponse = responsesAPIToAnthropic(copilotResult, originalModel);

      console.log(`[proxy] Responses: status=${copilotResult.status} | content_blocks=${anthropicResponse.content.length} | tokens: ${anthropicResponse.usage.input_tokens}in/${anthropicResponse.usage.output_tokens}out`);

      return res.json(anthropicResponse);
    }

    // ---- Standard models: use /chat/completions endpoint ----

    // Translate Anthropic → OpenAI Chat format
    const openAIBody = anthropicToOpenAI(req.body);

    console.log(`[proxy] ${originalModel} → ${openAIBody.model} | ${openAIBody.messages.length} messages | tools: ${openAIBody.tools?.length || 0}`);

    // Call Copilot API
    const copilotRes = await fetch(COPILOT_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`,
        'X-Request-Id': crypto.randomUUID(),
        'Machine-Id': machineId,
        'User-Agent': 'GitHubCopilotChat/0.12.0',
        'Editor-Version': 'vscode/1.90.0',
        'Editor-Plugin-Version': 'copilot-chat/0.12.0',
        'Openai-Organization': 'github-copilot',
        'Openai-Intent': 'conversation-agent',
        'Copilot-Integration-Id': 'vscode-chat',
      },
      body: JSON.stringify(openAIBody),
    });

    if (!copilotRes.ok) {
      const errText = await copilotRes.text();
      console.error(`[proxy] Copilot API error ${copilotRes.status}: ${errText}`);
      return res.status(copilotRes.status).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Copilot API error (${copilotRes.status}): ${errText}`,
        },
      });
    }

    const copilotResult = await copilotRes.json();

    // Translate OpenAI → Anthropic format
    const anthropicResponse = openAIToAnthropic(copilotResult, originalModel);

    console.log(`[proxy] Response: stop_reason=${anthropicResponse.stop_reason} | content_blocks=${anthropicResponse.content.length} | tokens: ${anthropicResponse.usage.input_tokens}in/${anthropicResponse.usage.output_tokens}out`);

    res.json(anthropicResponse);
  } catch (err: any) {
    console.error('[proxy] Error:', err.message);
    res.status(500).json({
      type: 'error',
      error: { type: 'api_error', message: err.message },
    });
  }
});

// ---------------------------------------------------------------------------
// CORS Proxy — allows the browser fetch_url tool to bypass CORS restrictions
// Accepts POST with JSON body: { url, method?, headers?, body? }
// Also accepts GET with ?url= query param for simple fetches
// ---------------------------------------------------------------------------

app.all('/cors-proxy', async (req, res) => {
  // Support both GET ?url=... and POST { url, method, headers, body }
  let targetUrl: string;
  let targetMethod: string;
  let targetHeaders: Record<string, string> = {};
  let targetBody: string | undefined;

  if (req.method === 'POST' && req.body?.url) {
    // Structured request from agent-worker
    targetUrl = req.body.url;
    targetMethod = req.body.method || 'GET';
    targetHeaders = req.body.headers || {};
    targetBody = req.body.body;
  } else {
    // Simple GET ?url=...
    targetUrl = req.query.url as string;
    targetMethod = 'GET';
  }

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target URL' });
  }

  try {
    const fetchOptions: RequestInit = {
      method: targetMethod,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,es;q=0.8,fr;q=0.7',
        'Accept-Encoding': 'identity',
        'DNT': '1',
        'Upgrade-Insecure-Requests': '1',
        ...targetHeaders,
      },
    };

    // Forward body for POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(targetMethod) && targetBody) {
      fetchOptions.body = targetBody;
      // Set Content-Type if not already set
      const headers = fetchOptions.headers as Record<string, string>;
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }

    const response = await fetch(targetUrl, fetchOptions);
    const contentType = response.headers.get('content-type') || 'text/plain';
    const body = await response.text();

    // Truncate large responses (500KB)
    const truncated = body.length > 500_000 ? body.slice(0, 500_000) + '\n[truncated]' : body;

    res.set('Content-Type', contentType);
    res.set('X-Original-Status', String(response.status));
    res.status(response.status).send(truncated);

    console.log(`[cors-proxy] ${targetMethod} ${targetUrl} → ${response.status} (${body.length} bytes)`);
  } catch (err: any) {
    console.error(`[cors-proxy] Error fetching ${targetUrl}:`, err.message);
    res.status(502).json({ error: `Failed to fetch: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`\n🔌 OpenBrowserClaw Copilot Proxy running on http://localhost:${PORT}`);
  console.log(`   Health:  GET  http://localhost:${PORT}/health`);
  console.log(`   Auth:    POST http://localhost:${PORT}/auth/github-token`);
  console.log(`   Messages: POST http://localhost:${PORT}/v1/messages`);
  console.log(`   CORS:    GET  http://localhost:${PORT}/cors-proxy?url=...`);
  if (githubToken) {
    console.log(`   GitHub token: configured (from env)`);
    // Pre-warm the Copilot token
    getCopilotJWT().then(() => {
      console.log('   Copilot JWT: ready ✓');
    }).catch((err) => {
      console.error(`   Copilot JWT: failed — ${err.message}`);
    });
  } else {
    console.log('   GitHub token: not set — use POST /auth/github-token or set GITHUB_TOKEN env var');
  }
  console.log('');
});
