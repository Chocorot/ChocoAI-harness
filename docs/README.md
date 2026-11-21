# Harness docs

Read the doc for the area you are about to change. Update it in the same change.

| Doc | Area |
|---|---|
| [ts-rewrite.md](ts-rewrite.md) | The 2026-11-21 rewrite from Python to TypeScript/Next.js: layout, what was kept, what changed, test status |
| [deploy.md](deploy.md) | Dockerfile, CI/CD, the server `.env`, go-live order, local run |
| [auth-and-modes.md](auth-and-modes.md) | Choco SSO sign-in, session cookie, public / user / shell / admin modes, endpoints, env vars |
| [storage-isolation.md](storage-isolation.md) | One DB per user, one directory per session, what is and is not isolated |
| [internet.md](internet.md) | web_fetch / web_search, SSRF guard, SearxNG deploy |
| [agent-mode.md](agent-mode.md) | Plan + delegate tools, budgets, coming back after a dropped connection |
| [pwa-and-ui-design.md](pwa-and-ui-design.md) | The app UI: files, what it does, app-feel and design rules, what is verified |
| [attachments.md](attachments.md) | Photos (vision) and documents (txt, docx, pdf): limits, what the model gets, serving, setting |
| [automations.md](automations.md) | Scheduled prompts: schedule data, scheduler, permissions, API |
| [branding-and-seo.md](branding-and-seo.md) | The mark, icons, favicon, social preview, manifest, SEO tags |
| [chats.md](chats.md) | Chat titles (instant + model-written), renaming, per-chat thinking effort |
| [errors.md](errors.md) | Typed errors, what the user sees, what the model sees, retries, failure log |
| [chat-streaming.md](chat-streaming.md) | `/task` request and SSE events, run queue, keepalive, status events |

Where the code is: `src/core/` (engine, no framework), `src/server/` (HTTP glue and SSO), `src/ui/` (React app), `src/app/` (Next routes and layout). Tests sit next to the code (`*.test.ts`); `test/golden/` holds reference outputs captured from the old Python app.
