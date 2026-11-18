# ChocoAI harness

Tiny coding-agent loop for small-context (16K) OpenAI-compatible models such as LM Studio.
Python 3.11+ standard library only. About 35 MB RSS idle. State lives in one SQLite file.

| File | Role |
|---|---|
| `harness.py` | CLI, agent loop, streaming, context compaction, optional HTTP mode |
| `tools.py` | The 4 tools (`read_file`, `edit_file`, `write_file`, `run_bash`) and their JSON schemas |
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

## HTTP mode and health checks

```bash
curl -s http://localhost:1235/v1/models                      # backend alive? (LM Studio)
curl -s localhost:8080/health                                # harness alive -> {"ok": true}
curl -s -XPOST localhost:8080/task -d '{"goal":"write hello.py and run it"}'
# -> {"session": 3, "reply": "..."}
curl -s -XPOST localhost:8080/task -d '{"session":3,"goal":"now add a --name flag"}'
```

One task at a time (single-threaded). **No auth**: it binds to 127.0.0.1 by default and executes shell
commands for whoever can reach it. Never expose it without a reverse proxy with auth.

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
