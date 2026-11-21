# Automations (scheduled prompts)

Code: `automations.py` (schedule maths, CRUD, `Scheduler`), `harness.py` (`run_automation`, `_automations`), table `automations` in `db.py`, page in `web/js/app.js` (`automationsSheet`).
Tests: `AutomationUnitTests`, `SchedulerTests`, `AutomationApiTests` in `test_harness.py`.
Signed-in users only (visitors have none). Switched off for everybody with the setting `max_automations` = 0.

## What it is
A saved prompt that runs by itself: **name + prompt + schedule**. Each run becomes a new saved chat titled `⏰ <name>` in the owner's chat list (first message = the prompt), and the job records `last_run`, `last_status` (`ok` or `kind: message` of the failure, see errors.md) and `last_session` (the chat to open).

## Schedule (data, not code)
- `{"kind":"interval","every_min":N}`: N minutes after the previous run. N from `min_interval_min` (setting, default 15) to 10080 (one week). The page offers 15 min, 30 min, hour, 2 h, 6 h, 12 h, day.
- `{"kind":"daily","at":"HH:MM"}`: wall-clock time in `HARNESS_TZ` (a zone name like `Asia/Kuala_Lumpur`, default UTC). Daylight saving follows the zone (a 23 hour day stays 09:00 local). An unknown zone, or an image without a tz database, falls back to UTC instead of crashing; the image installs `tzdata`.
- A new kind = a branch in `next_run()` and `clean_schedule()` (and a row in the page's form).
- Times on the page: "every day at 07:30" is server time (the form says which zone); "next ..." is shown in the browser's time.

## Running
- One scheduler thread (started by `--serve`) wakes every 30 s and runs due jobs one after another. `next_run` is moved forward **before** a job runs, so a crash can't make it loop, and a job runs at most once per due time.
- **Missed runs are not replayed**: after the server was down, a job whose time passed runs once and is scheduled from now.
- A job that is still running is not started again. `Run now` runs it in the background without moving its schedule (400 if it is already running).
- Jobs go through the normal run queue with priority 0.5 behind a live chat of the same kind of user (users 1, automations 1.5, visitors 2): a job never delays a chat that is waiting. If the line is full the job fails with `busy` for that time and tries again at its next due time.
- Budgets are the normal ones (`max_turns`, `max_seconds`, `max_run_tokens`).

## Permissions (deliberately tighter than the chat)
Runs as the owner with their tools **minus the shell**, even for `HARNESS_SHELL_USERS`: an unattended job that reads web pages could be steered by a page's text (prompt injection) and nobody is watching. They keep web search/fetch, the plan and helper tools, and files inside the run's own session folder. Photos and documents are not attached to jobs.

## API (the caller's own jobs only, 404 for anything else, 401 for visitors)
| | |
|---|---|
| `GET /api/automations` | `{"automations":[{id,name,prompt,schedule,enabled,nextRun,lastRun,lastStatus,lastSession}]}` |
| `POST /api/automations` | `{name, prompt, schedule}` (name 1-60, prompt 1-2000 chars); limit `max_automations` per user (default 5) |
| `PATCH /api/automations/<id>` | any of `name, prompt, schedule, enabled`; the next run is recomputed only when the schedule changes or the job is switched back on |
| `DELETE /api/automations/<id>` | removes the job (its past chats stay) |
| `POST /api/automations/<id>/run` | run now |
`/api/me` reports `capabilities.automations` and `capabilities.timezone`. Settings: `max_automations`, `min_interval_min`.

## Storage
The table lives in the owner's own DB file (storage-isolation.md), so the scheduler finds jobs by scanning `<data>/users/*/harness.db` on every tick. Each job row keeps the owner's address.

## Limits and gaps
- Only the server clock matters; jobs run only while the harness is up (it is a thread in the same process, not cron).
- Scanning every user's DB each 30 s is fine for a handful of users, not for thousands.
- No run history beyond the last run (the chats are the history), no notifications (the chat list is the inbox), no retry of a failed run before its next due time.
- Editing a job in the page changes name, prompt and schedule; there is no per-job time zone.
