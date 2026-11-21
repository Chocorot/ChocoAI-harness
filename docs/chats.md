# Chat titles, renaming and thinking effort

Code: `harness.py` (`EFFORT`, `short_title`, `clean_title`, `smart_title`, `_session_patch`), `db.py` (session columns, `rename`, `get_session`), `web/js/app.js` (`fillList`, `openMenu`, `startRename`, `watchTitle`, `effortMenu`), `web/js/icons.js` (`effortIcon`).
Tests: `TitleUnitTests`, `ChatManagementTests` in `test_harness.py`; `node --test web/test/*.test.mjs`.

## Titles
- **Instant title**: a new chat is named at once from its first message (`short_title`): first line, markdown and links reduced (a URL becomes its host), cut at a word near 48 characters. Empty text gives "New chat". The typed text is kept as `goal`; the list shows `title`.
- **Model-written title**: after the **first answer of a new chat** the harness asks the model for a title of at most 6 words (`smart_title`, a background thread): no tools, `max_tokens` 60, effort low, queued **behind live chats** (priority users + 0.5, and skipped if two are already waiting). The reply is cleaned (`clean_title`: first line, `Title:` prefix, quotes and markdown removed, no full stop, max 60 characters). The page looks for the new title a few seconds after the answer (about 3, 7, 11, then every 10 s, six tries) and updates the list and the header.
- If the title request fails, times out, is refused as busy, or comes back empty, **nothing happens**: the instant title stays and the user sees no error. Costs a few seconds of model time per new chat (more on a slow, thinking model; a thinking model may use the whole 60 tokens on reasoning and return nothing, which also just keeps the instant title). Switch it off with the setting `smart_titles` (dashboard) to keep instant titles only.
- Each chat has `title_state`: 0 = instant, 1 = model-written, 2 = named by the user or by a job (automations are called "⏰ name"). **A title can only move 0 to 1 once, and state 2 is never overwritten**, even if the model's answer arrives after the user renamed. Follow-up messages never ask for another title.
- Older databases get the new columns (`title`, `title_state`, `effort`) added when they are opened; chats without a title show their first message.

## Renaming and deleting
- Each chat row has a **⋯** button (hover on desktop, always visible on touch) opening a small menu: **Rename** and **Delete** (a second tap, "Tap again to delete").
- Rename edits the name in place in the row: Enter or leaving the field saves, Esc cancels. The list does not refresh while a name is being typed.
- `PATCH /api/sessions/<id>` `{"title": "..."}` (1 to 80 characters after trimming and collapsing spaces) sets the name and locks it. 404 for another user's chat, 401 signed out, 403 for a foreign `Origin`.
- The highlight of the open chat covers the whole row (one block); hover and press use the shared overlay (pwa-and-ui-design.md).

## Thinking effort (Low / Medium / High, per chat)
- A small meter button (three bars) sits in the message box, for visitors and signed-in users. It opens a menu with the three levels and a one-line description each; new chats start at Medium.
- **Signed in**: the level belongs to the chat. It is stored (`sessions.effort`), sent with every message, shown again when the chat is opened, and changing it in an open chat is saved at once (`PATCH /api/sessions/<id>` `{"effort": "high"}`). A chat opened later keeps its own level; other chats are unaffected.
- **Visitors**: one chat, so one level, kept in the browser (`choco.public.effort`) and sent in the request body.
- **What it does** (`harness.EFFORT`, one table: label, description, `param`, `hint`): it adds a sentence to the system prompt ("Reasoning effort: low. Answer directly and briefly..." / "...high. Think the problem through carefully...") **and** sends `reasoning_effort: "low"` or `"high"` in the backend request. Medium sends nothing and adds nothing, so it behaves exactly like before. The page builds its menu from `/api/me` (`capabilities.effort`), so a new level is a new row in the table.
- **Caveat, important**: the effect is up to the model. `reasoning_effort` is honoured by some models (e.g. gpt-oss through LM Studio) and ignored by others; the prompt sentence is a soft nudge. **I could not test the lyna model** (`qwen/qwen3.6-35b-a3b`). If Low/High make no visible difference there, the model ignores both, and the real switch for Qwen is a template option or a different model; tell me and I will add the right switch to `EFFORT`.
- Helpers (`delegate`) inherit the chat's level for the backend field; automations and titles use their own fixed levels (automations: the default; titles: low).

## Not done
- No bulk delete, folders, search, pinning or archiving.
- Rename is by the owner only; there is no "undo title" back to the automatic one (rename it again).
- A visitor's effort is per browser, not per conversation, because visitors have one conversation.
