// ---------------------------------------------------------------------------
// OpenBrowserClaw — Agent Worker
// ---------------------------------------------------------------------------
//
// Runs in a dedicated Web Worker. Owns the Claude API tool-use loop.
// Communicates with the main thread via postMessage.
//
// This is the browser equivalent of NanoClaw's container agent runner.
// Instead of Claude Agent SDK in a Linux container, we use raw Anthropic
// API calls with a tool-use loop.

import type { WorkerInbound, WorkerOutbound, InvokePayload, CompactPayload, ConversationMessage, ThinkingLogEntry, TokenUsage } from './types.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { ANTHROPIC_API_URL, ANTHROPIC_API_VERSION, COPILOT_PROXY_URL, CORS_PROXY_URL, FETCH_MAX_RESPONSE } from './config.js';
import type { ApiProvider } from './config.js';
import { readGroupFile, writeGroupFile, listGroupFiles } from './storage.js';
import { executeShell } from './shell.js';
import { ulid } from './ulid.js';
import { isHtmlPreviewCompletion } from './agent-loop.js';

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (event: MessageEvent<WorkerInbound>) => {
  const { type, payload } = event.data;

  switch (type) {
    case 'invoke':
      await handleInvoke(payload as InvokePayload);
      break;
    case 'compact':
      await handleCompact(payload as CompactPayload);
      break;
    case 'cancel':
      // TODO: AbortController-based cancellation
      break;
  }
};

// Shell emulator needs no boot — it's pure JS over OPFS

// ---------------------------------------------------------------------------
// Message sanitization — ensure tool_use/tool_result pairing
// ---------------------------------------------------------------------------

/**
 * Strip tool_use blocks from an assistant content array.
 * Used when the model returned tool_use blocks but stop_reason != 'tool_use'
 * (e.g. stop_reason === 'max_tokens' mid-tool-call).
 */
function stripToolUseBlocks(content: any[]): any[] {
  const filtered = content.filter((b: any) => b.type !== 'tool_use');
  return filtered.length > 0 ? filtered : [{ type: 'text', text: '' }];
}

/**
 * Ensure every assistant message with tool_use blocks is followed by a user
 * message with matching tool_result blocks. Orphaned tool_use blocks are
 * stripped to prevent Anthropic API 400 errors.
 */
function sanitizeMessages(messages: ConversationMessage[]): ConversationMessage[] {
  const result: ConversationMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Check assistant messages with tool_use blocks
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolUseIds = msg.content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => b.id);

      if (toolUseIds.length > 0) {
        // Check if next message has matching tool_results
        const next = messages[i + 1];
        const hasResults = next?.role === 'user' && Array.isArray(next.content) &&
          next.content.some((b: any) => b.type === 'tool_result');

        if (!hasResults) {
          // Strip orphaned tool_use blocks — keep only text
          result.push({ ...msg, content: stripToolUseBlocks(msg.content) });
          continue;
        }
      }
    }

    result.push(msg);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Agent invocation — tool-use loop
// ---------------------------------------------------------------------------

async function handleInvoke(payload: InvokePayload): Promise<void> {
  const { groupId, messages, systemPrompt, apiKey, model, maxTokens, provider } = payload;

  post({ type: 'typing', payload: { groupId } });
  log(groupId, 'info', 'Starting', `Model: ${model} · Max tokens: ${maxTokens}`);

  // Reset auto-continue counter for this invocation
  autoContinueCount = 0;

  try {
    let currentMessages: ConversationMessage[] = [...messages];
    let iterations = 0;
    let hasUsedTools = false; // Track if any tool has been called in this invocation
    const maxIterations = 30; // Safety limit — pause & resume handles longer tasks

    // Loop detection — track recent tool calls to catch repetitive patterns
    const recentToolCalls: string[] = []; // "toolName:inputHash" signatures
    const LOOP_THRESHOLD = 3; // same tool+input 3 times → break the loop

    // Extract the original user request (last user message) for nudge context
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const userTask = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? lastUserMsg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
        : '';
    const taskSnippet = userTask.length > 300 ? userTask.slice(0, 300) + '…' : userTask;

    while (iterations < maxIterations) {
      iterations++;

      const body = {
        model,
        max_tokens: maxTokens,
        cache_control: { type: 'ephemeral' },
        system: systemPrompt,
        messages: sanitizeMessages(currentMessages),
        tools: TOOL_DEFINITIONS,
      };

      const useProxy = (provider || 'anthropic') === 'copilot-proxy';
      const apiUrl = useProxy ? COPILOT_PROXY_URL : ANTHROPIC_API_URL;
      const headers: Record<string, string> = useProxy
        ? { 'Content-Type': 'application/json' }
        : {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_API_VERSION,
            'anthropic-dangerous-direct-browser-access': 'true',
          };

      log(groupId, 'api-call', `API call #${iterations}`, `${currentMessages.length} messages · ${useProxy ? 'Copilot proxy' : 'Anthropic direct'}`);

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${errBody}`);
      }

      const result = await res.json();

      // Emit token usage
      if (result.usage) {
        post({
          type: 'token-usage',
          payload: {
            groupId,
            inputTokens: result.usage.input_tokens || 0,
            outputTokens: result.usage.output_tokens || 0,
            cacheReadTokens: result.usage.cache_read_input_tokens || 0,
            cacheCreationTokens: result.usage.cache_creation_input_tokens || 0,
            contextLimit: getContextLimit(model),
          },
        });
      }

      // Log any text blocks in the response (intermediate reasoning)
      for (const block of result.content) {
        if (block.type === 'text' && block.text) {
          const preview = block.text.length > 200 ? block.text.slice(0, 200) + '…' : block.text;
          log(groupId, 'text', 'Response text', preview);
        }
      }

      if (result.stop_reason === 'tool_use') {
        if (!hasUsedTools) {
          hasUsedTools = true;
        }
        // Reset nudge counter every time tools run successfully —
        // so text-only responses AFTER tools always get a fresh nudge budget
        autoContinueCount = 0;
        // Execute all tool calls
        const toolResults = [];
        for (const block of result.content) {
          if (block.type === 'tool_use') {
            const inputPreview = JSON.stringify(block.input);
            const inputShort = inputPreview.length > 300 ? inputPreview.slice(0, 300) + '…' : inputPreview;
            log(groupId, 'tool-call', `Tool: ${block.name}`, inputShort);

            post({
              type: 'tool-activity',
              payload: { groupId, tool: block.name, status: 'running' },
            });

            const output = await executeTool(block.name, block.input, groupId);

            const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
            const outputShort = outputStr.length > 500 ? outputStr.slice(0, 500) + '…' : outputStr;
            log(groupId, 'tool-result', `Result: ${block.name}`, outputShort);

            post({
              type: 'tool-activity',
              payload: { groupId, tool: block.name, status: 'done' },
            });

            toolResults.push({
              type: 'tool_result' as const,
              tool_use_id: block.id,
              content: typeof output === 'string'
                ? output.slice(0, 100_000)
                : JSON.stringify(output).slice(0, 100_000),
            });
          }
        }

        // --- Loop detection ---
        // Track tool call signatures; if same tool+input appears LOOP_THRESHOLD
        // times, the model is stuck (e.g. retrying a blocked search engine).
        for (const block of result.content) {
          if (block.type === 'tool_use') {
            const sig = `${block.name}:${JSON.stringify(block.input).slice(0, 200)}`;
            recentToolCalls.push(sig);
          }
        }
        // Count occurrences of most recent call
        const lastSig = recentToolCalls[recentToolCalls.length - 1];
        const repeatCount = recentToolCalls.filter(s => s === lastSig).length;
        if (repeatCount >= LOOP_THRESHOLD) {
          log(groupId, 'info', 'Loop detected', `Tool "${lastSig.split(':')[0]}" called ${repeatCount}× with same input — stopping`);
          post({
            type: 'response',
            payload: {
              groupId,
              text: `I tried the same approach ${repeatCount} times without success. Let me know if you'd like me to try a different strategy.`,
            },
          });
          return;
        }

        // Continue the conversation with tool results
        currentMessages.push({ role: 'assistant', content: result.content });
        currentMessages.push({ role: 'user', content: toolResults as any });

        // Re-signal typing between tool iterations
        post({ type: 'typing', payload: { groupId } });
      } else {
        // end_turn or max_tokens — extract text
        const text = result.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text)
          .join('');

        const cleaned = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();

        // Check if the model stopped mid-task (wants to continue but didn't use tools)
        // Strategy:
        //  - No tools used yet → always nudge (model is describing instead of acting)
        //  - Tools used, empty response → nudge (model froze)
        //  - Tools used, text response mid-run → nudge (model said "I'll do X" instead of doing it)
        //    Only accept text as final if it looks like a genuine completion (iteration > 2
        //    and we've already used tools — give the model 1 chance to self-correct)
        const isEmptyResponse = !cleaned;
        const lastToolSignature = recentToolCalls[recentToolCalls.length - 1] || '';
        const lastToolName = lastToolSignature.split(':', 1)[0];
        const isHtmlPreviewCompletionResponse = isHtmlPreviewCompletion(hasUsedTools, isEmptyResponse, lastToolName);
        const isMidTaskDescription = hasUsedTools && !isEmptyResponse && autoContinueCount < 2;
        const shouldNudge = autoContinueCount < MAX_AUTO_CONTINUES && (
          // No tools used yet in this entire invocation — keep pushing
          !hasUsedTools ||
          // Empty response after tools ran — model froze, nudge it
          (isEmptyResponse && !isHtmlPreviewCompletionResponse) ||
          // Model returned text mid-task instead of calling another tool — nudge once
          isMidTaskDescription
        );

        if (iterations < maxIterations && shouldNudge) {
          autoContinueCount++;
          
          const reason = !cleaned
            ? 'Model returned empty response — nudging to act'
            : 'Model returned text without tool calls — nudging to act';
          log(groupId, 'info', 'Auto-continue', reason);

          // Escalating nudge messages — include original task so model doesn't lose context
          const taskReminder = taskSnippet
            ? `\nReminder — the user's request: "${taskSnippet}"`
            : '';

          const nudgeMessages = [
            `Do not describe what you will do. Use tools now to fulfill the request.${taskReminder}`,
            `You must call a tool right now. Pick the most relevant tool and invoke it.${taskReminder}`,
            `Your next message MUST be a tool call, not text. Act immediately.${taskReminder}`,
          ];
          const nudgeIdx = Math.min(autoContinueCount - 1, nudgeMessages.length - 1);

          // Strip any tool_use blocks — this is a text/nudge path, not a tool execution path
          const safeContent = stripToolUseBlocks(result.content);
          currentMessages.push({ role: 'assistant', content: safeContent });
          currentMessages.push({
            role: 'user',
            content: !cleaned
              ? 'You did not provide a response or call a tool. ' + nudgeMessages[nudgeIdx]
              : nudgeMessages[nudgeIdx],
          });

          post({ type: 'typing', payload: { groupId } });
          continue; // Re-enter the loop
        }

        // If tools were used during this invocation, auto-save progress to MEMORY.md
        // so that if the user says "continue", the model knows what was done
        if (hasUsedTools && iterations > 2) {
          await saveProgressToMemory(groupId, taskSnippet, iterations, recentToolCalls);
        }

        post({ type: 'response', payload: { groupId, text: cleaned || (iterations > 1 ? '' : '(no response)') } });
        return;
      }
    }

    // If we hit max iterations — save progress to memory and invite user to continue
    log(groupId, 'info', 'Paused', `Reached ${maxIterations} iterations — saving progress to memory`);

    const toolSummary = buildToolSummary(recentToolCalls);
    await saveProgressToMemory(groupId, taskSnippet, iterations, recentToolCalls);

    post({
      type: 'response',
      payload: {
        groupId,
        text: `I've used ${iterations} tool calls so far (${toolSummary}). I saved my progress to memory. Say **"continue"** and I'll pick up where I left off.`,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', payload: { groupId, error: message } });
  }
}

// ---------------------------------------------------------------------------
// Progress auto-save helpers
// ---------------------------------------------------------------------------

function buildToolSummary(recentToolCalls: string[]): string {
  const counts = recentToolCalls
    .map(sig => sig.split(':')[0])
    .reduce((acc: Record<string, number>, tool) => { acc[tool] = (acc[tool] || 0) + 1; return acc; }, {});
  return Object.entries(counts)
    .map(([tool, count]) => `${tool} (${count}×)`)
    .join(', ');
}

/**
 * Save a progress note to MEMORY.md so the model can resume on the next invocation.
 * Replaces any previous in-progress note.
 */
async function saveProgressToMemory(
  groupId: string,
  taskSnippet: string,
  iterations: number,
  recentToolCalls: string[],
): Promise<void> {
  const toolSummary = buildToolSummary(recentToolCalls);

  // List files created/written during this run
  const filesWritten = recentToolCalls
    .filter(sig => sig.startsWith('write_file:'))
    .map(sig => {
      try { return JSON.parse(sig.slice('write_file:'.length)).path; } catch { return null; }
    })
    .filter(Boolean);
  const filesLine = filesWritten.length > 0
    ? `Files created: ${[...new Set(filesWritten)].join(', ')}`
    : '';

  const progressNote = [
    `## In-Progress Task (saved at ${new Date().toISOString()})`,
    `Task: ${taskSnippet || '(unknown)'}`,
    `Progress: ${iterations} iterations, tools used: ${toolSummary}`,
    filesLine,
    `Status: If user says "continue", resume from where you left off. Do NOT repeat work already done — read the files first.`,
  ].filter(Boolean).join('\n');

  try {
    let existingMemory = '';
    try {
      existingMemory = await readGroupFile(groupId, 'MEMORY.md');
    } catch { /* no memory yet */ }
    // Remove any previous in-progress note
    const cleaned = existingMemory.replace(/## In-Progress Task \(saved[\s\S]*?(?=##|$)/g, '').trim();
    const updatedMemory = cleaned ? `${cleaned}\n\n${progressNote}` : progressNote;
    await writeGroupFile(groupId, 'MEMORY.md', updatedMemory);
  } catch {
    // Memory save failed — not critical
  }
}

// ---------------------------------------------------------------------------
// Context compaction — ask Claude to summarize the conversation
// ---------------------------------------------------------------------------

async function handleCompact(payload: CompactPayload): Promise<void> {
  const { groupId, messages, systemPrompt, apiKey, model, maxTokens, provider } = payload;

  post({ type: 'typing', payload: { groupId } });
  log(groupId, 'info', 'Compacting context', `Summarizing ${messages.length} messages`);

  try {
    const compactSystemPrompt = [
      systemPrompt,
      '',
      '## COMPACTION TASK',
      '',
      'The conversation context is getting large. Produce a concise summary of the conversation so far.',
      'Include key facts, decisions, user preferences, and any important context.',
      'The summary will replace the full conversation history to stay within token limits.',
      'Be thorough but concise — aim for the essential information only.',
    ].join('\n');

    const compactMessages: ConversationMessage[] = [
      ...messages,
      {
        role: 'user' as const,
        content: 'Please provide a concise summary of our entire conversation so far. Include all key facts, decisions, code discussed, and important context. This summary will replace the full history.',
      },
    ];

    const body = {
      model,
      max_tokens: Math.min(maxTokens, 4096),
      cache_control: { type: 'ephemeral' },
      system: compactSystemPrompt,
      messages: compactMessages,
    };

    const useProxy = (provider || 'anthropic') === 'copilot-proxy';
    const apiUrl = useProxy ? COPILOT_PROXY_URL : ANTHROPIC_API_URL;
    const headers: Record<string, string> = useProxy
      ? { 'Content-Type': 'application/json' }
      : {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        };

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errBody}`);
    }

    const result = await res.json();
    const summary = result.content
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('');

    log(groupId, 'info', 'Compaction complete', `Summary: ${summary.length} chars`);
    post({ type: 'compact-done', payload: { groupId, summary } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', payload: { groupId, error: `Compaction failed: ${message}` } });
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  groupId: string,
): Promise<string> {
  try {
    switch (name) {
      case 'bash': {
        const result = await executeShell(
          input.command as string,
          groupId,
          {},
          Math.min((input.timeout as number) || 30, 120),
        );
        let output = result.stdout;
        if (result.stderr) output += (output ? '\n' : '') + result.stderr;
        if (result.exitCode !== 0 && !result.stderr) {
          output += `\n[exit code: ${result.exitCode}]`;
        }
        return output || '(no output)';
      }

      case 'read_file':
        return await readGroupFile(groupId, input.path as string);

      case 'write_file':
        await writeGroupFile(groupId, input.path as string, input.content as string);
        return `Written ${(input.content as string).length} bytes to ${input.path}`;

      case 'list_files': {
        const entries = await listGroupFiles(groupId, (input.path as string) || '.');
        return entries.length > 0 ? entries.join('\n') : '(empty directory)';
      }

      case 'web_search': {
        const query = input.query as string;
        if (!query) return 'Error: missing "query" parameter';

        const encoded = encodeURIComponent(query);
        // Bing works well with server-side fetch (no JS required).
        // Google requires JS rendering — doesn't work with plain HTTP.
        const engines = [
          { name: 'Bing',     url: `https://www.bing.com/search?q=${encoded}` },
          { name: 'Google',   url: `https://www.google.com/search?q=${encoded}&num=10&hl=en&gbv=1` },
        ];

        for (const engine of engines) {
          try {
            const searchRes = await fetch(CORS_PROXY_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: engine.url, method: 'GET' }),
            });

            if (!searchRes.ok) continue;

            const html = await searchRes.text();
            const text = stripHtml(html);

            // Check if we got a CAPTCHA / bot block
            if (text.includes('unusual traffic') || text.includes('not a robot') ||
                text.includes('complete the following challenge') || text.length < 200) {
              log(groupId, 'info', 'Search blocked', `${engine.name} returned a CAPTCHA, trying next engine`);
              continue;
            }

            return `[${engine.name} results for "${query}"]\n${text.slice(0, FETCH_MAX_RESPONSE)}`;
          } catch {
            continue;
          }
        }

        return `Search failed — all engines blocked or unavailable for query: "${query}". Try using fetch_url with a known URL instead.`;
      }

      case 'fetch_url': {
        const targetUrl = input.url as string;
        const method = (input.method as string) || 'GET';

        // Route through CORS proxy (server-side fetch bypasses CORS)
        // Send all fetch params as a structured JSON POST to the proxy
        let fetchRes: Response;
        try {
          fetchRes = await fetch(CORS_PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: targetUrl,
              method,
              headers: input.headers || undefined,
              body: input.body || undefined,
            }),
          });
        } catch {
          // Proxy not available — try direct (will likely fail for cross-origin)
          fetchRes = await fetch(targetUrl, {
            method,
            headers: input.headers as Record<string, string> | undefined,
            body: input.body as string | undefined,
          });
        }

        const rawText = await fetchRes.text();
        const contentType = fetchRes.headers.get('content-type') || '';
        const status = `[HTTP ${fetchRes.status}]\n`;

        // Strip HTML to reduce token usage
        let body = rawText;
        if (contentType.includes('html') || rawText.trimStart().startsWith('<')) {
          body = stripHtml(rawText);
        }

        return status + body.slice(0, FETCH_MAX_RESPONSE);
      }

      case 'update_memory':
        await writeGroupFile(groupId, 'MEMORY.md', input.content as string);
        return 'Memory updated successfully.';

      case 'create_task': {
        // Post a dedicated message to the main thread to persist the task
        const taskData = {
          id: ulid(),
          groupId,
          schedule: input.schedule as string,
          prompt: input.prompt as string,
          enabled: true,
          lastRun: null,
          createdAt: Date.now(),
        };
        post({ type: 'task-created', payload: { task: taskData } });
        return `Task created successfully.\nSchedule: ${taskData.schedule}\nPrompt: ${taskData.prompt}`;
      }

      case 'javascript': {
        try {
          // Indirect eval: (0, eval)(...) runs in global scope and
          // naturally returns the value of the last expression —
          // no explicit `return` needed.
          const code = input.code as string;
          const result = (0, eval)(`"use strict";\n${code}`);
          if (result === undefined) return '(no return value)';
          if (result === null) return 'null';
          if (typeof result === 'object') {
            try { return JSON.stringify(result, null, 2); } catch { /* fall through */ }
          }
          return String(result);
        } catch (err: unknown) {
          return `JavaScript error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'html_preview': {
        const html = input.html as string;
        const title = (input.title as string) || 'Preview';
        const height = Math.min((input.height as number) || 400, 800);

        // Send HTML to main thread for rendering in the chat
        post({
          type: 'html-preview',
          payload: { groupId, html, title, height },
        });

        return `HTML preview rendered: "${title}" (${html.length} bytes, ${height}px tall)`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: unknown) {
    return `Tool error (${name}): ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function post(message: WorkerOutbound): void {
  (self as unknown as Worker).postMessage(message);
}

/** Auto-continue budget — prevents infinite nudge loops. */
let autoContinueCount = 0;
const MAX_AUTO_CONTINUES = 5;

/**
 * Extract readable text from HTML, stripping tags, scripts, styles, and
 * collapsing whitespace.  Runs in the worker (no DOM), so we use regex.
 */
function stripHtml(html: string): string {
  let text = html;
  // Remove script/style/noscript blocks entirely
  text = text.replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // Remove all tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '');
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
  return text;
}

/** Map model names to their context window limits (tokens). */
function getContextLimit(_model: string): number {
  // The actual session context window — 200k tokens for Claude Sonnet/Opus.
  return 200_000;
}

function log(
  groupId: string,
  kind: ThinkingLogEntry['kind'],
  label: string,
  detail?: string,
): void {
  post({
    type: 'thinking-log',
    payload: { groupId, kind, timestamp: Date.now(), label, detail },
  });
}
