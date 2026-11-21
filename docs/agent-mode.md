# Agent mode (plan, look, think, delegate)

Code: `harness.py` (`agent_loop`, `call_tool`, `Run`, `tool_update_plan`, `tool_delegate`, `system_text`). Tests: `AgentModeTests`, `RunningFlagTests`, `ToolTableTests`.
Available to signed-in users and admin. Visitors get plain chat.

## The loop
- The model answers or calls tools; every tool result goes back to it; it thinks again. Repeat until it answers without a tool call. This is the "look, think, look, think" loop (ReAct style). It is the same loop as before, now with budgets and two extra tools.
- There is no mode switch: the model decides. The system prompt gets one hint per allowed tool (`tools.TOOLS[...]["prompt"]`, assembled by `system_text(allow)`), including "for a task with several steps, call `update_plan` first".

## update_plan(steps)
- `steps`: list of `{text, status}` with status `todo | doing | done` (plain strings count as todo). Cleaned: max 20 steps, 200 chars each.
- Emits `{"t":"plan","steps":[...]}` for the page's live checklist and answers `ok: plan has N steps, M done`. Nothing else is stored: the plan is the arguments of the model's last `update_plan` call in the session.

## delegate(task)
- Runs a helper on a self-contained subtask in a **fresh context** (system prompt + the task only). The helper has the caller's tools minus `update_plan` and `delegate` (no nesting, depth 1), and a smaller turn limit (`delegate_turns`, default 8).
- Only the helper's final summary (max 3000 chars) returns to the parent as the tool result. The helper's conversation is thrown away; its tool calls are still audited in the session's `audit` table.
- Its stream events carry `"sub": <delegate call id>` so the page can nest them under the call.
- If the helper fails, the parent gets `error[delegate_failed]` and carries on.
- **Runs one after another.** There is no parallel mode: lyna serves one stream and the run queue already serialises model calls, so parallel helpers would only wait. What delegation buys is a small parent context (see compaction), not speed. Parallelism is only worth adding after measuring whether LM Studio batches concurrent requests; not measured.

## Budgets (a run never ends silently)
| setting | default | stops the run when |
|---|---|---|
| `max_turns` | 15 | model calls in the run (CLI `--max-turns` wins) |
| `max_seconds` | 900 | wall clock, shared with helpers |
| `max_run_tokens` | 200000 | sum of prompt + reply tokens over all calls (prompts are re-sent each turn) |
| `delegate_turns` | 8 | model calls of one helper |
- On a stop: a `{"t":"notice","kind":"budget","reason","msg"}` event, the run returns `[stopped: <reason>]`, history stays valid; the user says "continue" to go on. Complex agent tasks will often need `max_turns` above 15: raise it in the dashboard if so.

## Coming back after the connection dropped (phones background tabs)
- A started run always finishes on the server and saves every step. `GET /api/sessions/<id>` returns `running` (true while the run executes) plus the messages saved so far; the page polls it until `running` is false.
- Not done: the half-written reply of the current model call is not available until that call finishes, and there is no event replay (`/api/runs/<id>/events` from the plan was dropped in favour of this much smaller mechanism).
