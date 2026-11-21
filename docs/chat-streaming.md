# Chat streaming and the run queue

Code: `harness.py` (`make_server`, `Sse`, `keepalive`, `run_agent`), `runq.py`. Tests: `RunQueueTests`, `ServerErrorTests.test_busy_queued_and_keepalive`.

## `POST /task`
- Body (JSON object, max 1 MB): `goal` (text), `session` (number, resume), `stream` (bool), `retry` (bool, see errors.md). Needs `goal` or `session`.
- Auth: `Authorization: Bearer $HARNESS_TOKEN` when the token is set. (This changes in phase 2: login cookie and public mode.)
- Non-stream: `{"session": id, "reply": text}`.
- Stream: `text/event-stream`, lines `data: {json}` separated by a blank line.

## SSE events
| `t` | fields | meaning |
|---|---|---|
| `queued` | `pos` | waiting in line, `pos` runs ahead (sent at once, then every 10 s) |
| `session` | `id` | the run started |
| `status` | `phase` = `model` (`turn`, `max`) or `tool` (`name`) | what the harness is doing now |
| `think` / `text` | `d` | reasoning / answer delta |
| `tool` | `id, name, args` | tool call about to run |
| `result` | `id, d, ok` | tool result (cut to 2000 chars), `ok:false` = failed |
| `retrying` | `attempt, in, kind, msg, reset` | automatic retry (see errors.md) |
| `error` | see errors.md | terminal |
| `done` | | terminal |

A comment line `: ka` is sent every 10 s (`harness.KEEPALIVE`). Pages ignore it. It stops Cloudflare and other proxies from cutting a stream that is silent during a long prefill or a model load (about 22 s to the first token on lyna).

## Run queue (`runq.RunQueue`)
- One run at a time (the local model serves one stream). Others wait in line, ordered by priority then arrival (`prio` is 1 for everything today; later: user < automation < public).
- Line length is limited by the `max_queue` setting (default 8). A full line answers `busy` (HTTP 503, or an `error` event). An idle queue never refuses.
- A client that disconnects while waiting leaves the line. Once a run has started it always finishes, so history stays consistent.
- `/health`, `/` and `/manage/*` never wait.
- Idle/busy status in the manifest is `queue.busy()`.
