# Plan: rewrite the harness in TypeScript / Next.js (PROPOSAL, nothing built yet)

Status 2026-11-21: written for Sir to approve. Based on reading every doc in `docs/`, `README.md`, and these code paths: `harness.py` (all 1083 lines), `tools.py`, `db.py`, `settings.py` (fields), `errors.py`/`auth.py`/`web.py`/`attach.py`/`automations.py`/`runq.py` (through their docs, not line by line), the web UI file list, Dockerfile, compose and CI. The 134 Python tests were read as a list of classes, not each one.

## Why, and what Sir already decided
- Same components and the same login as status, mail and SSO (`@chocorot/design`, the Choco SSO), so the AI app looks and behaves like the others.
- Full rewrite in TypeScript, frontend and backend together in one app (Sir, 2026-11-21).
- Visitors keep free public chat without signing in (today's behaviour). The SSO is only for the signed-in features.

## What exists today (the thing to reproduce)
| Part | Python today | Size | TypeScript counterpart |
|---|---|---|---|
| Agent core | `harness.py`: `compact`, `parse_sse`, `chat`, `call_model` (retry/overflow), `agent_loop` (budgets), `delegate`, `update_plan`, `repair_tail`, titles, effort table | ~500 lines | `src/core/*`, framework-free |
| HTTP API | `harness.py` `make_server` handler: `/api/*`, `/task`, `/manage/*`, `/health`, static files, SSE + keepalive, CSRF origin check, per-user DB routing | ~500 lines | Next route handlers + thin glue |
| Tools | `tools.py`: read/edit/write file, run_bash, web_fetch, web_search + plan/delegate | 133 | `src/core/tools.ts` |
| Internet | `web.py`: SSRF-guarded fetch, SearxNG | 172 | `src/core/web.ts` (undici with a pinned-address connect) |
| Attachments | `attach.py`: photos, txt/docx/pdf (poppler) | 199 | `src/core/attach.ts` (+ a zip reader for docx) |
| Automations | `automations.py`: schedule maths, CRUD, scheduler thread | 201 | `src/core/automations.ts`, started from `instrumentation.ts` |
| Errors / settings / queue / db | table-driven | 129 / 177 / 52 / 133 | same tables, same JSON file, same SQLite schema |
| Auth | IMAP password check, HMAC cookie, modes table | 164 | OIDC client (like status/mail) + the same modes table |
| UI | `web/`: plain HTML/CSS/ES modules, ~1.6k lines | | React + `@chocorot/design` components |
| Tests | `test_harness.py`, 134 tests, 27 classes | 1985 | ported to `node:test`, plus differential tests (below) |

## Compatibility contract (must not break; this is what makes cut-over and rollback possible)
1. **Data stays readable**: same SQLite schema and file layout: `<data>/users/<uid>/harness.db`, `<workspace>/users/<uid>/<session>/`, legacy `harness.db`, `settings.json` (+ `.bak`). `uid = sha256(lower(email))[:32]`, so every existing user's chats survive. The TypeScript app adds no column the Python one cannot ignore, so rolling back to Python works.
2. **`/manage/*` keeps its exact shapes** (manifest, sessions, errors, `PUT settings`, `HARNESS_ADMIN_TOKEN`, 404 when unset): the node agent and the status dashboard's AI page depend on them (`choc-node-agent` `docs/ai-gateway.md`). Golden-file tests from the Python output.
3. **The SSE event protocol stays** (`queued, session, status, think, text, tool, result, plan, notice, trimmed, retrying, error, done`, `sub` on helper events, `: ka` keepalive every 10 s), the `/task` admin endpoint, `/health`, error kinds and HTTP codes (`errors.KINDS`).
4. **Env vars and compose**: `BASE_URL`, `API_KEY`, `MODEL`, `HARNESS_TOKEN`, `HARNESS_ADMIN_TOKEN`, `HARNESS_TZ`, `HARNESS_TRUST_PROXY`, `HARNESS_PUBLIC_URL`, `SEARCH_URL`; label `choc.ai.harness`; volumes `harness-data`/`harness-ws`; searxng service unchanged. Removed: `HARNESS_SESSION_KEY`, `HARNESS_SHELL_USERS`, `MAIL_HOST/PORT` (replaced by the SSO and its roles).
5. **Per-user isolation rules stay** (paths only from the verified identity and an integer session id; foreign/unknown id = same 404).

## Architecture
- **Next.js 16, Node runtime, Docker on the home server** (as today). It cannot go on Vercel: it needs a long-lived process (in-memory run queue, scheduler), local files and a shell.
- `src/core/` has NO framework imports (relative `.ts` imports) so `npm test` runs it on bare Node, like the SSO. `src/app/` is thin: route handlers and React.
- **SQLite via `better-sqlite3`** with plain SQL mirroring `db.py` (same tables), not an ORM: the schema is frozen by the compatibility contract.
- **A run is detached from its request**: the browser dropping the stream must not stop the run (today's rule: "a started run always finishes"). The route handler starts the run, streams events to the response while it is open, and lets the run continue when the stream is cancelled.
- **Scheduler**: `instrumentation.ts` `register()` starts the 30 s tick once at server start.
- **Login**: OIDC client to the Choco SSO, client id `ai`, roles `user` and `shell` (shell = today's `HARNESS_SHELL_USERS`). Session cookie like status (sealed JWE, 12 h, no password). Admin stays the bearer `HARNESS_TOKEN`. Existing 30-day cookies stop working: everybody signs in once (their chats are kept).
- **UI**: React pages built from `@chocorot/design` (`AppHeader`, `LoginLayout`, shared `ui/*`, theme, motion). Markdown through a vetted renderer (no raw HTML). Same screens: public chat, chat list (rename, delete), message cards (thinking, tool calls, plan, errors with Retry), composer with attachments and effort menu, automations sheet, account sheet, install prompt, service worker.
- **New dependencies** (to approve): `next`, `react`, the design package's peers, `better-sqlite3`, `jose`, `undici` (the SSRF-pinned connection), a markdown library, a small zip reader (docx). Docker keeps `poppler-utils` and `tzdata`. The Python "zero pip" rule goes away; `AGENTS.md` is rewritten (data-driven tables rule stays).

## Problems found while reading (pre-existing, to fix in the rewrite, not copy)
1. **`run_bash` leaks the server's secrets.** `tools.run_bash` calls `subprocess.run(shell=True)` without an `env`, so the command inherits `HARNESS_TOKEN`, `HARNESS_ADMIN_TOKEN`, `HARNESS_SESSION_KEY`, `API_KEY`. Anyone allowed the shell (admin, `HARNESS_SHELL_USERS`) or anything that steers the model into running `env` can read them, and with `HARNESS_SESSION_KEY` could forge any user's cookie. The rewrite runs commands with a minimal, explicit environment. (The Python app should get this one-line fix too if it stays in service for long.)
2. `run_bash` also can read other users' files (already documented in `storage-isolation.md`). Real confinement needs a sandbox: see decision 1 (probably admin-only).
3. No per-user quota (sessions, disk); thinking text not stored; the manage API cannot see per-user chats. Kept as gaps unless Sir wants them.

## Phases (each ends with tests and a check Sir can see)
| # | Work | Verified by |
|---|---|---|
| 0 | Branch + Next/TS skeleton, CI, `AGENTS.md`/docs rewritten, design package wired. **No push to `main`**: a push to `main` builds `:latest` and watchtower deploys it over the running Python app. | typecheck, empty app builds |
| 1 | `src/core`: errors table, settings table + JSON file, db layer, auth modes, model client (fetch streaming + SSE parse), compaction, retry/overflow, agent loop + budgets, plan/delegate, tools, SSRF-safe fetch, SearxNG, attachments, run queue, automations, titles | Ported unit tests + **differential tests**: golden JSON produced by the Python functions (compact, parse_sse, titles, plan cleaning, trim_history, schedule maths, settings validation, error table) that the TypeScript must reproduce exactly |
| 2 | HTTP API in route handlers: all `/api/*`, `/task`, `/manage/*`, `/health`, CSRF origin check, per-user DB routing, SSE + keepalive, detached runs, scheduler | Ported API tests against a fake OpenAI backend (the Python `FakeModel` pattern); `/manage/*` golden files; a recorded SSE conversation compared event by event with the Python server |
| 3 | SSO login, roles to modes, sealed session cookie, break-glass off | Browser run against the local SSO (as done for status and mail) |
| 4 | The UI in React with the shared components | Playwright runs: public chat, sign-in, tool run with the fake model, thinking/plan/error cards, retry, attachments, rename/delete, automations, effort, phone width, light/dark, screenshots read by me |
| 5 | Hardening: env scrub (see above), shell sandbox if possible, response headers/CSP kept | Tests that `env` shows no secrets; sandbox tests if built |
| 6 | Staging then cut-over on the home server (**each step needs Sir's approval**): image tag `:next` (never `:latest` until cut-over), run beside the old app on port 8422 against COPIES of the volumes, real model (lyna), real SSO and search; then swap compose to the new image; keep a Python image tag for rollback; delete Python after a quiet period | Real conversation with tools, an attachment, an automation, `/manage/*` seen by the dashboard |

## Risks and unknowns
- **Memory**: Python is ~35 MB, `mem_limit` 256m. A Next.js server will need roughly 150 to 300 MB (not measured). The home server has about 1.8 GB available (2026-11-21). Plan: `mem_limit` 512m, measured in phase 6.
- **Shell sandbox** needs kernel/container features (user namespaces, bubblewrap) that I have not checked on the home server. Without them the safe options are: shell for admin only, or keep the allow-list and accept the file-read gap.
- Streaming behind Cloudflare Tunnel with Next's route handlers: the keepalive and `X-Accel-Buffering` behaviour must be re-proven (the Python one is proven in production).
- Fidelity: 134 tests describe today's behaviour; behaviour not covered by a test can change silently. The differential tests exist to catch exactly that.
- Docker is not installed on the development Mac: the image build, `better-sqlite3` native build and poppler are only testable in CI or on the server.
- The vision setting and the thinking-effort parameter depend on the model (`qwen/qwen3.6-35b-a3b` on lyna), never tested here (already noted in `attachments.md` and `chats.md`).

## Decisions (Sir, 2026-11-21)
1. **Shell**: sandbox it if the server allows, else admin-only. Always scrub the environment. Read-only check of the home server: the harness container runs with Docker's default seccomp profile, no extra capabilities, not privileged, user `app`. The default profile normally blocks the user namespaces that bubblewrap needs, so the sandbox will probably NOT work without loosening the container (an extra capability or a custom seccomp profile), which I would not do for a shell tool without Sir's explicit OK. Not tested (needs a trial run in a container on the server, which needs approval). Expect the fallback: shell for the bearer-token admin only; signed-in users keep file tools, web, plan and helpers.
2. **CLI**: dropped. Scripts use `/task` with the admin token.
3. **Memory**: `mem_limit` 512m for the new app, measured in staging. For reference, live on 2026-11-21: Python harness 32 MiB of its 256 MiB, SearxNG 127 MiB of 384 MiB.
4. **Cut-over**: staging beside the old app on copies of the data (image tag `:next`, port 8422), then swap the compose image; the Python image tag stays for rollback.

## Not done / not verified
- Nothing is built. No dependency is installed. No estimate of time is given on purpose.
- I did not read `attach.py`, `automations.py`, `web.py`, `errors.py`, `runq.py` and the UI JS line by line; their docs were read. Phase 1 starts by reading each before porting it.
