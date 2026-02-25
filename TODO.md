# OpenBrowserClaw — TODO

## Architecture: Current vs. Proposed

```
┌─────────────────────────────────────────────────────────────────┐
│                    CURRENT ARCHITECTURE                          │
│                                                                 │
│  Main Agent                                                     │
│    │                                                            │
│    ├── web_search → 5KB results                                 │
│    ├── fetch_url  → 100KB raw HTML → STRAIGHT into context      │
│    ├── fetch_url  → 100KB more                                  │
│    ├── fetch_url  → 100KB more                                  │
│    │                                                            │
│    └── Context: 2K (prompt) + 300K (fetches) = 💀               │
│        Model processes junk HTML, wastes tokens reading          │
│        navbars, footers, ads...                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                PROPOSED: SUB-AGENT SUMMARIZER                   │
│                                                                 │
│  Main Agent                                                     │
│    │                                                            │
│    ├── fetch_url("docs.openclaw.ai/architecture")               │
│    │     ↓                                                      │
│    │   [raw HTML: 500KB]                                        │
│    │     ↓                                                      │
│    │   Sub-agent (cheap API call, no tools):                    │
│    │     System: "You are an extractor. Summarize this page     │
│    │              focusing on: {taskSnippet}"                   │
│    │     Input: raw HTML (truncated to 50KB)                    │
│    │     Output: ~500 tokens focused summary                    │
│    │     ↓                                                      │
│    │   [summary: 500 tokens] → into agent context               │
│    │                                                            │
│    ├── Next fetch... → same process                             │
│    │                                                            │
│    └── Total context: 2K + (4 × 500) = 4K 🎉                   │
│        Model works with clean, focused information              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Priority 1: Critical (affects user experience now)

### 1. Sub-agent Summarizer for fetch_url / web_search
**Impact**: Highest. Each fetch dumps up to 100KB of raw HTML into context, exhausting the window in 3-4 fetches.

**Approach**: After `fetch_url` or `web_search` returns raw HTML, make a second cheap API call (same model, `max_tokens: 1024`, no tools) to summarize the content focused on the user's task. Replace the 100KB blob with a ~500 token summary in the tool result.

**Files**: `src/agent-worker.ts` — `executeTool()` for `fetch_url` and `web_search`

**Tradeoff**: +1 API call per fetch (~0.5s latency, minimal cost) → 50x context reduction per fetch.

---

### 2. html_preview → Auto-save to Workspace
**Impact**: High. If the agent uses `html_preview` without `write_file` first, the generated HTML is ephemeral — lost on error or page reload.

**Approach**: In `executeTool()` for `html_preview`, automatically `writeGroupFile()` the HTML content before rendering. This way every preview is persisted.

**Files**: `src/agent-worker.ts` — `executeTool()` case for `html_preview`

---

### 3. Save Progress on Error (catch block)
**Impact**: High. When the agent crashes mid-task (e.g. API 400), all progress context is lost because `saveProgressToMemory()` only runs on normal completion.

**Approach**: In the `catch` block of `handleInvoke()`, call `saveProgressToMemory()` with whatever `recentToolCalls` and `iterations` were accumulated before the error.

**Files**: `src/agent-worker.ts` — `handleInvoke()` catch block

---

### 4. System Prompt: Always write_file before html_preview
**Impact**: Medium. Reinforces the auto-save behavior with model-level guidance.

**Approach**: Add rule to system prompt: *"When generating HTML content, always save it to the workspace with write_file first, then render it with html_preview. This ensures work is never lost."*

**Files**: `src/orchestrator.ts` — `buildSystemPrompt()`

---

## Priority 2: Quality of Life

### 5. LOOP_THRESHOLD 3 → 5
**Impact**: Medium. Current threshold of 3 is too aggressive — legitimate retries (e.g. `list_files` on a directory that doesn't exist yet) trigger false positive loop detection.

**Approach**: Change `LOOP_THRESHOLD` from 3 to 5 in `agent-worker.ts`.

**Files**: `src/agent-worker.ts` — L66

---

### 6. Planning Phase in System Prompt
**Impact**: Medium. The model sometimes jumps into action without thinking through the approach, wasting tool calls.

**Approach**: Add to system prompt: *"For complex multi-step tasks, briefly plan your approach in your first response (which tools to use, in what order) before executing. Keep the plan under 100 words."*

**Files**: `src/orchestrator.ts` — `buildSystemPrompt()`

---

### 7. Extract Testable Functions from agent-worker.ts
**Impact**: Low (developer experience). Core logic like `shouldNudge`, `detectLoop`, `sanitizeMessages` are inline and untested.

**Approach**: Extract to `src/agent-logic.ts` with pure functions, add unit tests in `tests/agent-logic.test.ts`.

**Functions to extract**: `shouldNudgeModel()`, `detectLoop()`, `sanitizeMessages()`, `stripToolUseBlocks()`, `buildToolSummary()`

---

### 8. AbortController-based Cancellation
**Impact**: Medium. Currently there's no way to cancel a running agent invocation — marked as TODO in code.

**Approach**: Wire an `AbortController` signal through the fetch calls and tool executions. Listen for a `cancel` message from the main thread.

**Files**: `src/agent-worker.ts` — L36 (existing TODO)

---

## Priority 3: Future Enhancements

### 9. Streaming Responses
All API calls currently wait for full response. Streaming would show partial text/tool activity in real-time.

### 10. Binary File Support in ZIP Export
`collectAllGroupFiles()` reads all files as text — binary files (images, etc.) would be corrupted in ZIP exports. Need to use `arrayBuffer()` instead of `text()` for binary types.

### 11. Multi-group Support
Infrastructure exists (groupId routing) but UI only uses `DEFAULT_GROUP_ID`. Would enable separate workspaces per conversation.

### 12. Search Engine Fallback Robustness
Bing and Google both may return CAPTCHAs. Consider integrating a dedicated search API (Brave Search, SerpAPI) as a more reliable fallback.

---

## Already Completed ✅

- [x] `web_search` tool (Bing primary, Google fallback)
- [x] Loop detection (LOOP_THRESHOLD=3)
- [x] Task snippet in nudge messages
- [x] `isMidTaskDescription` nudge condition
- [x] `autoContinueCount` reset on every tool_use
- [x] CLAUDE.md → MEMORY.md rename
- [x] Auto-save progress to MEMORY.md on normal completion
- [x] Pause & Resume at iteration limit
- [x] Realistic User-Agent in CORS proxy
- [x] Message sanitization (orphaned tool_use fix)
- [x] ZIP download of workspace
- [x] `collectAllGroupFiles` recursive walker

## Bugs Fixed ✅

- [x] DuckDuckGo CAPTCHA loop (→ web_search with Bing)
- [x] Nudge context loss ("¿A qué tarea te refieres?")
- [x] Model stops at "Now let me build the game:" (→ isMidTaskDescription)
- [x] autoContinueCount exhaustion from early nudges
- [x] Orphaned tool_use → API 400 error (→ sanitizeMessages)
