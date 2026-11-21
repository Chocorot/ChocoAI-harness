# Harness docs

Read the doc for the area you are about to change. Update it in the same change.

| Doc | Area |
|---|---|
| [auth-and-modes.md](auth-and-modes.md) | Sign-in with the mail account, cookie, public / user / shell / admin modes, endpoints, env vars |
| [storage-isolation.md](storage-isolation.md) | One DB per user, one directory per session, what is and is not isolated |
| [internet.md](internet.md) | web_fetch / web_search, SSRF guard, SearxNG deploy |
| [agent-mode.md](agent-mode.md) | Plan + delegate tools, budgets, coming back after a dropped connection |
| [pwa-and-ui-design.md](pwa-and-ui-design.md) | The app UI: files, what it does, app-feel and design rules, what is verified |
| [attachments.md](attachments.md) | Photos (vision) and documents (txt, docx, pdf): limits, what the model gets, serving, setting |
| [automations.md](automations.md) | Scheduled prompts: schedule data, scheduler, permissions, API |
| [branding-and-seo.md](branding-and-seo.md) | The mark, icons, favicon, social preview, manifest, SEO tags, how they are generated |
| [chats.md](chats.md) | Chat titles (instant + model-written), renaming, per-chat thinking effort |
| [errors.md](errors.md) | Typed errors, what the user sees, what the model sees, retries, failure log |
| [chat-streaming.md](chat-streaming.md) | `/task` request and SSE events, run queue, keepalive, status events |

Not written yet: a deploy doc (deploy steps are in the README and in internet.md / attachments.md for their parts). The rework plan is in Sir's Claude plan file for 2026-11-21: public chat-only tier, DMS-mail login, per-user storage, vision and documents, scheduled prompts, app-like UI.

Rework progress:
- [x] Phase 1: errors, queue, keepalive, catch-all (v0.3.0)
- [x] Phase 2: per-user storage, auth, public/user modes (v0.4.0)
- [x] Phase 3: internet tools, agent mode (v0.5.0)
- [x] Phase 4: frontend rewrite (PWA, motion) (v0.6.0)
- [x] Phase 5: vision and documents (v0.7.0; vision stays off until the model is confirmed to see images)
- [x] Phase 6: automations (v0.8.0)
