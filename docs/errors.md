# Errors

Code: `src/core/errors.ts` (the table), `src/core/model.ts` (`chat`, `callModel`), `src/core/agent.ts` (`runAgent`, `repairTail`), `src/server/http.ts` (`guarded`, `logError`), `src/core/tools.ts` (`err`), `src/core/db.ts` (`errors` table).
Tests: `src/core/errors.test.ts`, `src/core/model.test.ts`, `src/core/agent.test.ts`, `src/server/api.test.ts` (failures, busy, rate limits).

## One table
- `errors.KINDS`: one row per failure kind: HTTP `status`, `retryable` (UI shows Retry), `auto` (harness retries by itself), `msg` (plain words for the user), `hint` (what the model is told).
- A new kind = a new row. `HarnessError(kind, code=..., detail=...)`: `kind` is the category, `code` the specific cause (`http_502`, `refused`, `timeout`...).
- Unknown exceptions become `internal` (traceback to stderr, never shown to the user).

| kind | when | auto-retry | Retry button |
|---|---|---|---|
| upstream_down | backend refused / DNS / connection dropped | yes | yes |
| upstream_timeout | no answer within 600 s | no | yes |
| upstream_5xx | backend 5xx or 429 | yes | yes |
| upstream_4xx | backend rejected the request | no | no |
| upstream_auth | backend 401/403 (gateway key wrong) | no | no |
| upstream_bad_stream | garbled or cut-off reply | yes | yes |
| context_overflow | prompt does not fit the window | shrinks once | no |
| busy | run queue full | no | yes |
| rate_limited | too many requests / sign-in attempts (429) | no | yes |
| login_unavailable | sign-in is unavailable (503). Not raised by the SSO flow today (it redirects with `?signin=error`); kept so the table matches the old app | no | yes |
| bad_request / not_found / auth / forbidden | client mistakes (400 / 404 / 401 / 403) | no | no |
| internal | bug in the harness | no | yes |

The backend's own HTTP error body is read (bounded) and kept in `detail`; context overflow is recognised from it (`errors.OVERFLOW`).

## What the user sees
- Non-stream `/task`: HTTP status from the table and `{"error": msg, "kind", "code", "retryable", "rid"}`.
- Stream: a terminal SSE event `{"t":"error","kind","code","msg","retryable","detail","rid","note","d"}` (`d` = `msg`, kept for simple clients). `rid` is an 8-char request id, also in the log: quote it when reporting a problem.
- `{"t":"retrying","attempt","in","kind","msg","reset"}` before each automatic retry. `reset:true` means the reply already started: the page must discard the half-streamed text.
- Tool failures stay in the stream as `result` events with `ok:false`.

## What the model sees
- Tool errors have one shape: `error[code]: what happened. hint` (`tools.ts` `err`). Codes: `edit_mismatch`, `denied`, `timeout`, `unknown_tool`, `forbidden`, `bad_args`, `not_found`, `permission`, `invalid`, `tool_failed`, `interrupted`, and from the internet tools `bad_url`, `fetch_blocked`, `fetch_failed`, `search_unavailable`, `search_failed`, plus `delegate_failed` (see internet.md, agent-mode.md). The tool table is `tools.ts` `TOOLS`; `errors.ToolError(code, message, hint)` is how a tool reports one.
- When a run fails, a note is saved in the session as an assistant message: `[run failed: kind/code] message hint`. The next turn sees it and can adapt (for example do a smaller step after a timeout).
- `{"session": id, "retry": true}` (no new goal) removes that note and continues where it stopped.
- A crash between a tool call and its result leaves an orphan call, which backends reject. `repairTail` adds stub results (`error[interrupted]`) on resume and before the failure note. Only the tail is repaired: orphans in the middle of very old sessions are not.

## Recovery (`model.ts` `callModel`)
- Transient kinds (`auto`) are retried `retries` times (setting, default 2) with waits 2 s, 6 s, 15 s (`errors.BACKOFF`).
- Context overflow: one retry with the history shrunk harder (`compact(messages, 1, keep_turns // 2)`). If nothing can be shrunk the user gets `context_overflow`.
- A 600 s timeout is never auto-retried (that would be 30 minutes of waiting).

## Catch-all and logging
- `guarded` (`http.ts`) wraps every route: whatever fails becomes a typed reply, JSON or an SSE error event. The socket is never closed silently.
- Bad JSON, bad types, missing or oversize body (1 MB): 400 `bad_request`. Unknown session: 404 before any stream opens.
- Server errors are logged as one JSON line on stderr and stored in the `errors` table (newest 200). Client mistakes (auth, not_found, bad_request, busy, forbidden, rate_limited) are not logged.
- `GET /manage/errors?limit=N` (admin token) returns them; `/manage/manifest` `stats.errors` is the count.

## Known gaps
- The app shows `error` events as cards (message, reference, Try again), `retrying` as a status line with a countdown, `queued` as "Waiting in line". A mid-stream retry with `reset:true` drops the half-streamed reply.
