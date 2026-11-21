# ChocoAI harness

Tiny coding-agent loop for small-context (16K) OpenAI-compatible models such as LM Studio.
Python 3.11+ standard library only (the web UI is plain files plus one vendored animation library). About 35 MB RSS idle. State lives in one SQLite file.

| File | Role |
|---|---|
| `harness.py` | CLI, agent loop, streaming, context compaction, optional HTTP mode |
| `tools.py` | The tool table (`read_file`, `edit_file`, `write_file`, `run_bash`, `web_fetch`, `web_search`, `update_plan`, `delegate`): schemas, prompt hints, handlers |
| `automations.py` | Scheduled prompts: schedule maths, CRUD, the scheduler thread ([docs/automations.md](docs/automations.md)) |
| `attach.py` | Photos (vision) and documents (txt, docx, pdf) attached to a message ([docs/attachments.md](docs/attachments.md)) |
| `web.py` | Internet for the model: page fetch with an SSRF guard, SearxNG search ([docs/internet.md](docs/internet.md)) |
| `auth.py` | Sign-in with the DMS mailbox (IMAP), signed cookie, the modes table, throttles, per-user storage paths ([docs/auth-and-modes.md](docs/auth-and-modes.md), [docs/storage-isolation.md](docs/storage-isolation.md)) |
| `errors.py` | The table of failure kinds: what the user sees, what the model is told, what is retried ([docs/errors.md](docs/errors.md)) |
| `runq.py` | Bounded run queue: one run at a time, the rest wait in line ([docs/chat-streaming.md](docs/chat-streaming.md)) |
| `web/` | The app UI served at `/`: HTML, CSS and ES modules, no build step, installable PWA ([docs/pwa-and-ui-design.md](docs/pwa-and-ui-design.md)). Tests: `node --test web/test/*.test.mjs` |
| `settings.py` | The settings table (system prompt, model, max turns, compaction, temperature, max tokens): validation, JSON file next to the DB, manifest |
| `db.py` | SQLite (`harness.db`): sessions, messages, token usage, tool audit log |
| `test_harness.py` | Offline tests: `python3 -m unittest test_harness` |

## Setup

```bash
cat >> .env <<'EOF'
BASE_URL=http://localhost:1235/v1
API_KEY=lm-studio
MODEL=qwen/qwen3.6-35b-a3b
EOF
python3 harness.py "create fib.py that prints 10 fibonacci numbers, then run it"
```

Those three values are the defaults. `HARNESS_DB` changes the DB path (default `./harness.db`).

## CLI

```
harness.py [goal] [--session ID] [--workspace DIR] [--auto-approve]
           [--max-turns 15] [--serve PORT] [--host 127.0.0.1]
```

- `goal`: the task. With `--session`, it is a follow-up message in that session.
- `--session ID`: resume a session. The id is printed as `[session N]` on start.
- `--workspace DIR`: where files and commands live (default `./workspace`).
- `--auto-approve`: skip the `y/N` prompt before every `run_bash`.
- `--max-turns`: model calls per run (default 15).
- `--serve PORT`: HTTP mode for always-on use (needs `--auto-approve`, no TTY). `--host` sets the bind address.

## HTTP mode, web chat and health checks

`--serve` also serves the web app at `/` (files in `web/`, an installable PWA): public visitors chat with no tools and keep one chat in
their browser; signed-in users get saved chats, tools, web search and plans; the model's thinking, tool calls, plan and errors are shown live.
Details: [docs/pwa-and-ui-design.md](docs/pwa-and-ui-design.md). Thinking is shown only if the backend returns it as `reasoning_content`
(LM Studio: enable "separate reasoning_content and content") or writes `<think>` tags; it is never stored in history. "Stop" only detaches the
browser; the server finishes the current run.

```bash
curl -s http://localhost:1235/v1/models                      # backend alive? (LM Studio)
curl -s localhost:8080/health                                # harness alive -> {"ok": true}
curl -s -XPOST localhost:8080/task -d '{"goal":"write hello.py and run it"}'
# -> {"session": 3, "reply": "..."}
curl -sN -XPOST localhost:8080/task -d '{"goal":"hi","stream":true}'
# -> SSE lines: data: {"t":"queued|session|status|think|text|tool|result|retrying|error|done", ...}
curl -s -XPOST localhost:8080/task -d '{"session":3,"goal":"now add a --name flag"}'
curl -s -XPOST localhost:8080/task -d '{"session":3,"retry":true}'   # continue after a failed run
```

Events, the queue and keepalive: [docs/chat-streaming.md](docs/chat-streaming.md). Failures are typed
(`kind`, `retryable`, request id `rid`), retried when transient, and noted in the session so the model knows:
[docs/errors.md](docs/errors.md).

One agent run at a time (others wait in a line of at most `max_queue`, then get a `busy` answer; `/health` and `/` stay responsive). `/task` executes shell commands. Set `HARNESS_TOKEN` and send
`-H "Authorization: Bearer $HARNESS_TOKEN"` on `/task` (`/health` stays open). `/task` does not exist (404) unless `HARNESS_TOKEN` is set, so there is no way to run it open by accident (`HARNESS_OPEN` was removed in v0.4.0).
Visitors and signed-in users use `/api/*` instead: visitors chat with no tools, signed-in users (any DMS mailbox, `HARNESS_SESSION_KEY` set) get saved chats in their own DB and workspace, and `HARNESS_SHELL_USERS` also get the shell.
See [docs/auth-and-modes.md](docs/auth-and-modes.md).

## Settings and the manage API (for the status dashboard)

Settings live in ONE table (`settings.py` `FIELDS`). They are saved in `settings.json` next to the DB (`/data/settings.json` in
Docker, previous version kept as `settings.json.bak`) and re-read on every call, so an edit applies from the next run with no
restart (also to resumed sessions). `--max-turns` on the command line still beats the saved value. A bad or hand-edited value in
the file is ignored (the default is used). A new setting = a new row in `FIELDS`; the dashboard shows it with no change.

The dashboard reaches this through the node agent (`choc-node-agent`, `docs/ai-gateway.md` has the contract). Endpoints, all under
`/manage/` and guarded by their **own** token `HARNESS_ADMIN_TOKEN` (not `HARNESS_TOKEN`; the two do not open each other's routes).
**No `HARNESS_ADMIN_TOKEN` set = the API does not exist (404).**

```bash
curl -s localhost:8080/manage/manifest -H "Authorization: Bearer $HARNESS_ADMIN_TOKEN"   # kind, status, backend, settings[], stats
curl -s -XPUT localhost:8080/manage/settings -H "Authorization: Bearer $HARNESS_ADMIN_TOKEN" \
  -d '{"settings":{"max_turns":10,"temperature":0.2}}'                                    # all-or-nothing; 400 with the reason
curl -s "localhost:8080/manage/sessions?limit=20" -H "Authorization: Bearer $HARNESS_ADMIN_TOKEN"
curl -s "localhost:8080/manage/errors?limit=20" -H "Authorization: Bearer $HARNESS_ADMIN_TOKEN"     # newest 200 server errors
```
A `null` value resets a setting to its default. `base_url` is shown read-only (it comes from the `BASE_URL` variable).
The compose file carries the label `choc.ai.harness=<url>` so the node agent finds the container by itself.

## Deploy

Docker (`python:3.12-slim`; inside a container `localhost` is the container itself):

```bash
docker build -t choco-harness .
docker run -d --name harness --restart unless-stopped -p 127.0.0.1:8080:8080 \
  -e BASE_URL=http://host.docker.internal:1235/v1 --add-host host.docker.internal:host-gateway \
  -v harness-data:/data -v harness-ws:/workspace choco-harness
```

systemd user unit: copy the repo to `~/ChocoAI-harness`, then follow the 3 commands at the top of
[harness.service](harness.service). Settings come from `~/ChocoAI-harness/.env`.

## CI/CD

Push to `main` -> GitHub Actions ([deploy.yml](.github/workflows/deploy.yml)) runs the tests, builds the image and
pushes `ghcr.io/chocorot/choco-harness:latest`. On the server, [docker-compose.yml](docker-compose.yml) runs that image
with the watchtower label, so watchtower (polls every 5 min) pulls and restarts it. No SSH secrets needed.
Server setup is one-time: copy `docker-compose.yml` **and the `searxng/` folder** next to `.env` in `~/ChocoAI-harness/`, add `SEARXNG_SECRET=<random>` to `.env`, then `docker compose up -d`.
Watchtower only updates images: a changed compose file or `searxng/settings.yml` must be copied by hand.
Named volumes `harness-data` / `harness-ws` survive updates. Roll back by pinning the compose image to a
`sha-<commit>` tag.

## Agent mode and internet

Signed-in users and admin get `web_fetch`, `web_search`, `update_plan` and `delegate` on top of the file tools: the model plans, looks, thinks and
repeats, with budgets (`max_turns`, `max_seconds`, `max_run_tokens`) that end a run with a notice instead of silently. See
[docs/agent-mode.md](docs/agent-mode.md) and [docs/internet.md](docs/internet.md) (includes the SearxNG setup).

## How it works

- **System prompt**: about 90 tokens by default, so turn-1 prefill is cheap (editable in the dashboard, 8000 characters max: a long prompt eats the 16K window).
- **Compaction**: tokens are estimated as `chars / 4`. Above 11,000, each request is sent with older
  history shrunk: `read_file` results become a one-line stub, other tool results are cut to 200 chars,
  large tool-call arguments (e.g. `write_file` content) are dropped. System prompt, original goal and the last
  4 turns are untouched. The DB keeps the full history; only what is sent is compacted.
- **Streaming**: assistant text prints as it arrives; tool calls (including several in one reply) are buffered
  and run in order after the reply finishes. Tool progress goes to stderr.
- **Tool results**: every failure has the shape `error[code]: what happened. hint`. Old `read_file` / `web_fetch` / `web_search` results are replaced by a one-line stub when compacting.
- **Tool safety**: `edit_file` fails unless `old_text` occurs exactly once. `read_file` caps at 400 lines per call.
  `run_bash` output is cut to 4,000 chars per stream. Every tool call is logged in the `audit` table.
- **Limits**: `max_turns` stops runaway loops; a stopped session can be continued with `--session`.

Inspect the DB: `sqlite3 harness.db "select tool, result from audit order by id desc limit 5"`.

## Known limits

- The workspace is a working directory, **not a sandbox**. File tools reject paths outside it, but a shell
  command can go anywhere. Use `--auto-approve` only in Docker or a throwaway user.
- Token counts are estimates. If the real window is exceeded the harness shrinks the history once and retries; if that is not enough you get a `context_overflow` error (lower the `compact_at` setting).
- Transient backend errors are retried (`retries` setting). Anything else stops the run, saves a failure note in the session and tells the user why; resume with `--session` or `{"retry": true}`.
- Thinking is shown only when the backend sends `reasoning_content`; it is never stored in history.
- `/task` and the shell users run shell commands as the container user: not a sandbox, and shell users can read other users' files. Keep `HARNESS_TOKEN` secret and `HARNESS_SHELL_USERS` short.
