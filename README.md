# ChocoAI harness

Chat and agent loop for small-context (16K) OpenAI-compatible models such as LM Studio. Next.js 16 / TypeScript, one container, SQLite, signed in with the Choco SSO, built with the shared `@chocorot/design` components.
Rewritten from Python on 2026-11-21: [docs/ts-rewrite.md](docs/ts-rewrite.md).

| Where | Role |
|---|---|
| `src/core/` | The engine, no framework: errors, settings, modes, run queue, SQLite, web (SSRF guard), attachments, tools, automations, model client, agent loop |
| `src/server/` | HTTP glue (`api.ts`), session cookie, SSO, SSE, shared state |
| `src/app/` | Next routes (`api/*`, `manage/*`, `task`, `health`), layout, robots, sitemap |
| `src/ui/` | The React app (chat, sidebar, composer, automations, account) |
| `public/` | Icons, manifest, service worker |
| `test/golden/` | Reference outputs captured from the old Python app |
| `searxng/` | Config for the web-search container |

## Develop

```bash
npm ci        # @chocorot/design is on GitHub Packages: export GH_PACKAGES_TOKEN (read:packages) first
npm test      # 119 Node tests, no Next needed
npm run typecheck
npm run build
BASE_URL=http://localhost:1235/v1 AUTH_SECRET=$(openssl rand -hex 32) npm run dev
```

Model backend defaults: `BASE_URL=http://localhost:1235/v1`, `API_KEY=lm-studio`, `MODEL=qwen/qwen3.6-35b-a3b`. `HARNESS_DB` (default `./harness.db`) and `HARNESS_WORKSPACE` (default `./workspace`) say where the data lives. Without `SSO_*` everybody is a visitor. All variables: [docs/auth-and-modes.md](docs/auth-and-modes.md) and [docs/deploy.md](docs/deploy.md).

## Who can do what

- **Visitors** chat with no tools; the chat stays in their browser.
- **Signed in** (SSO role `user` for client `ai`): saved chats in their own DB and workspace, file tools, web search, plans, attachments, scheduled prompts.
- **Shell** (`run_bash`): admin only (`/task`). The SSO role `shell` only gets it when `HARNESS_SHELL=unconfined` is set, because there is no sandbox.
- Details: [docs/auth-and-modes.md](docs/auth-and-modes.md), [docs/storage-isolation.md](docs/storage-isolation.md).

## HTTP API

```bash
curl -s localhost:8080/health                                # -> {"ok": true}
curl -s -XPOST localhost:8080/task -H "Authorization: Bearer $HARNESS_TOKEN" -d '{"goal":"write hello.py and run it"}'
# -> {"session": 3, "reply": "..."}
curl -sN -XPOST localhost:8080/task -H "Authorization: Bearer $HARNESS_TOKEN" -d '{"goal":"hi","stream":true}'
# -> SSE lines: data: {"t":"queued|session|status|think|text|tool|result|retrying|error|done", ...}
curl -s -XPOST localhost:8080/task -H "Authorization: Bearer $HARNESS_TOKEN" -d '{"session":3,"retry":true}'   # continue after a failed run
```

`/task` runs shell commands, so it does not exist (404) unless `HARNESS_TOKEN` is set. The page uses `/api/*` instead. Events, queue and keepalive: [docs/chat-streaming.md](docs/chat-streaming.md). Failures are typed (`kind`, `retryable`, request id `rid`), retried when transient, and noted in the session so the model knows: [docs/errors.md](docs/errors.md). One agent run at a time; the others wait in a bounded line (`max_queue`), then get `busy`.

## Settings and the manage API (for the status dashboard)

Settings live in ONE table (`src/core/settings.ts` `FIELDS`), saved in `settings.json` next to the DB (previous version kept as `.bak`) and re-read on every call, so an edit applies from the next run with no restart. A bad value in the file is ignored (the default is used). A new setting = a new row; the dashboard shows it with no change.

The dashboard reaches this through the node agent (`choc-node-agent`, `docs/ai-gateway.md` has the contract). Endpoints under `/manage/`, guarded by their **own** token `HARNESS_ADMIN_TOKEN` (not `HARNESS_TOKEN`). **No `HARNESS_ADMIN_TOKEN` = the API does not exist (404).**

```bash
curl -s localhost:8080/manage/manifest -H "Authorization: Bearer $HARNESS_ADMIN_TOKEN"   # kind, status, backend, settings[], stats
curl -s -XPUT localhost:8080/manage/settings -H "Authorization: Bearer $HARNESS_ADMIN_TOKEN" \
  -d '{"settings":{"max_turns":10,"temperature":0.2}}'                                    # all-or-nothing; 400 with the reason
curl -s "localhost:8080/manage/sessions?limit=20" -H "Authorization: Bearer $HARNESS_ADMIN_TOKEN"
curl -s "localhost:8080/manage/errors?limit=20" -H "Authorization: Bearer $HARNESS_ADMIN_TOKEN"     # newest 200 server errors
```
A `null` value resets a setting to its default. `base_url` is shown read-only (it comes from `BASE_URL`). The compose file carries the label `choc.ai.harness=<url>` so the node agent finds the container by itself.

## Deploy

Docker image, CI, the server `.env` and the go-live order: [docs/deploy.md](docs/deploy.md). Push to `main` -> GitHub Actions builds and pushes `ghcr.io/chocorot/choco-harness:latest`; watchtower on the server pulls it.

## How it works

- **System prompt**: about 90 tokens by default, so turn-1 prefill is cheap (editable in the dashboard, 8000 characters max: a long prompt eats the 16K window).
- **Compaction**: tokens are estimated as `chars / 4`. Above 11,000, each request is sent with older history shrunk: `read_file` / `web_fetch` / `web_search` results become a one-line stub, other tool results are cut to 200 chars, large tool-call arguments are dropped. System prompt, original goal and the last 4 turns are untouched. The DB keeps the full history; only what is sent is compacted.
- **Streaming**: assistant text is sent as it arrives; tool calls (including several in one reply) are buffered and run in order after the reply finishes.
- **Tool results**: every failure has the shape `error[code]: what happened. hint`.
- **Tool safety**: `edit_file` fails unless `old_text` occurs exactly once. `read_file` caps at 400 lines per call. `run_bash` output is cut to 4,000 chars per stream. Every tool call is logged in the `audit` table.
- **Budgets**: `max_turns`, `max_seconds`, `max_run_tokens` end a run with a notice instead of silently ([docs/agent-mode.md](docs/agent-mode.md), [docs/internet.md](docs/internet.md)).
- Chat titles, renaming and thinking effort: [docs/chats.md](docs/chats.md).

Inspect a DB: `sqlite3 harness.db "select tool, result from audit order by id desc limit 5"`.

## Known limits

- The workspace is a working directory, **not a sandbox**. File tools reject paths outside it (symlinks included), but a shell command can go anywhere: that is why the shell is admin-only by default.
- Token counts are estimates. If the real window is exceeded the harness shrinks the history once and retries; if that is not enough you get a `context_overflow` error (lower the `compact_at` setting).
- Transient backend errors are retried (`retries` setting). Anything else stops the run, saves a failure note in the session and tells the user why; resume with `{"retry": true}`.
- Thinking is shown only when the backend sends `reasoning_content` (LM Studio: enable "separate reasoning_content and content") or writes `<think>` tags; it is never stored in history.
- "Stop" only detaches the browser; the server finishes the current run.
- Not run yet: Docker image, a real SSO sign-in, a real model backend, phones. See [docs/pwa-and-ui-design.md](docs/pwa-and-ui-design.md) and [docs/ts-rewrite.md](docs/ts-rewrite.md).
