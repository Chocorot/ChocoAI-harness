# ChocoAI harness

Tiny coding-agent loop for small-context (16K) OpenAI-compatible models such as LM Studio.
Python 3.11+ standard library only. About 35 MB RSS idle. State lives in one SQLite file.

| File | Role |
|---|---|
| `harness.py` | CLI, agent loop, streaming, context compaction, optional HTTP mode |
| `tools.py` | The 4 tools (`read_file`, `edit_file`, `write_file`, `run_bash`) and their JSON schemas |
| `index.html` | Chat web page served at `/` (HTML+JS, no build step) |
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

`--serve` also serves a chat page at `/`: streams tokens live, shows the model's thinking and tool calls in
collapsible blocks, and keeps chats in the browser's `localStorage` (no accounts; clearing site data deletes
them; the server keeps the model-side history per session in `harness.db`). Enter the access token once via
"Access token…" in the sidebar. The page itself is public, `/task` is what the token protects.
Thinking is shown only if the backend returns it as `reasoning_content` (LM Studio: enable "separate
reasoning_content and content"); it is displayed but never stored in history. "Stop" only detaches the browser; the
server finishes the current run.

```bash
curl -s http://localhost:1235/v1/models                      # backend alive? (LM Studio)
curl -s localhost:8080/health                                # harness alive -> {"ok": true}
curl -s -XPOST localhost:8080/task -d '{"goal":"write hello.py and run it"}'
# -> {"session": 3, "reply": "..."}
curl -sN -XPOST localhost:8080/task -d '{"goal":"hi","stream":true}'
# -> SSE lines: data: {"t":"session|think|text|tool|result|error|done", ...}
curl -s -XPOST localhost:8080/task -d '{"session":3,"goal":"now add a --name flag"}'
```

One agent run at a time (others wait; `/health` and `/` stay responsive). `/task` executes shell commands. Set `HARNESS_TOKEN` and send
`-H "Authorization: Bearer $HARNESS_TOKEN"` on `/task` (`/health` stays open). Binding to any host other
than 127.0.0.1 (as the Docker image does) refuses to start without `HARNESS_TOKEN` unless you set `HARNESS_OPEN=1` (deliberately unauthenticated: anyone who can reach it can run commands in the container). For a public hostname
(e.g. a Cloudflare tunnel) also consider Cloudflare Access in front.

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
Server setup is one-time: copy `docker-compose.yml` next to `.env` in `~/ChocoAI-harness/`, then `docker compose up -d`.
Named volumes `harness-data` / `harness-ws` survive updates. Roll back by pinning the compose image to a
`sha-<commit>` tag.

## How it works

- **System prompt**: about 90 tokens, so turn-1 prefill is cheap.
- **Compaction**: tokens are estimated as `chars / 4`. Above 11,000, each request is sent with older
  history shrunk: `read_file` results become a one-line stub, other tool results are cut to 200 chars,
  large tool-call arguments (e.g. `write_file` content) are dropped. System prompt, original goal and the last
  4 turns are untouched. The DB keeps the full history; only what is sent is compacted.
- **Streaming**: assistant text prints as it arrives; tool calls (including several in one reply) are buffered
  and run in order after the reply finishes. Tool progress goes to stderr.
- **Tool safety**: `edit_file` fails unless `old_text` occurs exactly once. `read_file` caps at 400 lines per call.
  `run_bash` output is cut to 4,000 chars per stream. Every tool call is logged in the `audit` table.
- **Limits**: `max_turns` stops runaway loops; a stopped session can be continued with `--session`.

Inspect the DB: `sqlite3 harness.db "select tool, result from audit order by id desc limit 5"`.

## Known limits

- The workspace is a working directory, **not a sandbox**. File tools reject paths outside it, but a shell
  command can go anywhere. Use `--auto-approve` only in Docker or a throwaway user.
- Token counts are estimates. If the real window is exceeded you will get a backend error; lower `COMPACT_AT` in `harness.py`.
- No retries on backend errors: the run stops and prints the session id so you can resume.
- Model "thinking" output (`reasoning_content`) is ignored.
