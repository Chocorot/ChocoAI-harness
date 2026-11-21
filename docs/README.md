# Harness docs

Read the doc for the area you are about to change. Update it in the same change.

| Doc | Area |
|---|---|
| [auth-and-modes.md](auth-and-modes.md) | Sign-in with the mail account, cookie, public / user / shell / admin modes, endpoints, env vars |
| [storage-isolation.md](storage-isolation.md) | One DB per user, one directory per session, what is and is not isolated |
| [errors.md](errors.md) | Typed errors, what the user sees, what the model sees, retries, failure log |
| [chat-streaming.md](chat-streaming.md) | `/task` request and SSE events, run queue, keepalive, status events |

Planned (written when the feature lands): internet, agent-mode, attachments, automations, pwa-and-ui-design, deploy. The rework plan is in Sir's Claude plan file for 2026-11-21: public chat-only tier, DMS-mail login, per-user storage, vision and documents, scheduled prompts, app-like UI.

Rework progress:
- [x] Phase 1: errors, queue, keepalive, catch-all (v0.3.0)
- [x] Phase 2: per-user storage, auth, public/user modes (v0.4.0; the old page does not use it yet)
- [ ] Phase 3: internet tools, agent mode
- [ ] Phase 4: frontend rewrite (PWA, motion)
- [ ] Phase 5: vision and documents
- [ ] Phase 6: automations
