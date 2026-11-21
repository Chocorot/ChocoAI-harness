# The app UI (PWA) and its design rules

Code: `web/` (served by `harness.static_file`). Tests: `node --test web/test/*.test.mjs` (markdown, SSE parsing, `<think>` splitting, icons), `StaticTests` in `test_harness.py` (what is served, content types, CSP, traversal, offline file list).
No build step, no framework, no dependency except the vendored `web/vendor/motion.js` (see `web/vendor/README.md`).

## Files
| file | role |
|---|---|
| `index.html` | shell with a static skeleton, so something shows before JS runs |
| `app.css` | tokens, layout, every component |
| `js/theme.js` | sets the saved theme before first paint (a file, not inline, so the CSP can forbid inline scripts) |
| `js/app.js` | controller: routing, public vs signed-in chat, sheets, sign-in, theme, install, composer |
| `js/turn.js` | one assistant turn: thinking panel, streamed answer, tool cards, plan, status, notice, error. Fed by SSE events or by a saved chat |
| `js/md.js` | markdown (escape first, block by block, so streaming re-renders only the last block) |
| `js/sse.js` | SSE over fetch, inline `<think>` splitting |
| `js/attach.js` | photo shrinking, base64, and telling a saved user message's text, document chips and photos apart |
| `js/anim.js` | `motion` helpers (enter, pop, shake, sheet in/out); no-ops under reduced motion or if the library is missing |
| `js/icons.js` | inline SVG icon table |
| `sw.js`, `manifest.webmanifest`, `icons/` | installable app + offline shell |

Adding a JS module: add it to `SHELL` in `sw.js` (a test fails otherwise).

## What the page does
- **Built from `/api/me`**: `capabilities.history` (`client` = visitor, `user` = saved chats), `tools`, `login`. No tier or tool names in the logic. Suggestion chips need a tool (`needs`), tool cards come from `TOOL_UI`, error icons from `ERROR_ICON` (both tables in `turn.js`); an unknown tool or error kind still renders (generic card).
- **State in the URL**: `#/` new chat, `#/c/<id>` a saved chat, `#/login`.
- **Visitor**: one chat kept in `localStorage` (`choco.public.chat.v1`, last 100 messages); Reset is in the Account sheet (two-tap confirm). The page sends its history on every request. A failed attempt leaves a hidden note in that history for the model (see errors.md).
- **Signed in**: chat list (sidebar from 768 px, Chats sheet on phones), open/delete (two-tap confirm), new chat. Saved chats replay messages, tool calls, results and plans (thinking text is not stored, so reloaded chats show no thinking panel).
- **Attachments** (signed in, when `/api/me` says so): paperclip, paste, drag and drop; chips with a thumbnail above the composer; the sent message shows the photo and document chips; saved chats load them back from `/api/sessions/<id>/uploads/...` (attachments.md).
- **Automations** (when `/api/me` says `automations`): a clock button in the sidebar header (desktop) and a row in the Chats sheet (phone) open a sheet with the list (name, schedule, next/last run, on/off switch, Run now, Last result, two-tap Delete) and a form (name, prompt, Repeat or Daily). See automations.md.
- **Chat rows**: a ⋯ menu (Rename in place, Delete with a second tap); the whole row is highlighted as one block. **Effort**: a three-bar button in the composer opens Low / Medium / High (chats.md).
- **Streaming**: events are applied per animation frame; only the last markdown block re-renders, new blocks fade in, a pulsing dot marks the end of the text. "Jump to latest" appears when scrolled up; auto-scroll sticks only while near the bottom.
- **Thinking panel**: shimmer label with a live timer, open while reasoning streams, collapses to "Thought for Ns" when the answer starts (unless the user opened or closed it). Reasoning written inline as `<think>...</think>` is handled too.
- **Tool cards**: running / ok / failed with elapsed time; failures open by themselves. Helper output (`sub` events) is nested inside the Helper card. `update_plan` is shown as a live checklist instead of a card.
- **Status line**: waiting in line (N ahead), thinking step, retrying with a countdown. **Notices** (budget stops) have a Continue button. **Error cards** show the plain message, the reference id and Try again when retryable.
- **Connection dropped** (phone backgrounded): for a saved chat the page polls `GET /api/sessions/<id>` until `running` is false and then reloads it; a visitor gets an error card with Try again.
- Stop aborts the request. For a saved chat the run may still finish on the server; the page then catches up.

## App-feel rules (so it does not feel like a website)
- The page never scrolls: `html, body { overflow: hidden; overscroll-behavior: none }`, the app is `100dvh` (or the visual viewport height while the keyboard is open, set from `visualViewport`). Only the message list and sheets scroll.
- Composer is pinned at the bottom with `env(safe-area-inset-*)`; textarea `font-size: 16px` (iOS does not zoom on focus); Enter sends on desktop, inserts a newline on touch devices.
- Desktop sidebar (signed in): a button inside it closes it, the header then shows an open-sidebar button, and the choice is remembered (`choco-harness-sidebar`). Phones have no sidebar: the menu button opens the Chats sheet.
- Phones: panels are **bottom sheets** with a grab handle (drag down to close, backdrop tap, Esc); desktop: centred dialogs and a permanent sidebar.
- Touch targets are 44 px; press feedback is a small scale (`:active`), hover styles only inside `@media (hover: hover)`; no hover-only actions; no native `alert/confirm/prompt` (two-tap buttons and toasts instead).
- `-webkit-tap-highlight-color: transparent`, `touch-action: manipulation`, chrome (buttons) is not text-selectable, message text is.
- Installable: manifest (`display: standalone`), icons, `apple-mobile-web-app-*` tags, service worker (network first, cache as offline fallback; `/api/*` never cached). The Account sheet shows Install when the browser offers it, and a hint on iOS.
- Code blocks and tables scroll sideways inside their own box.

## Design rules taken from ChocoHost-status
Source: its `docs/design-principles.md`, `ui-design-system.md`, `ui-motion.md`, `src/app/globals.css`.
- Same oklch tokens (teal primary, `--background/--card/--muted/--accent/--border/--sidebar`, status colours `--up/--degraded/--down/--unknown`), radius 0.5 rem, light and dark with the same values; theme is System / Light / Dark with its own storage key `choco-harness-theme`.
- Colour is never the only signal (icons on tool state, error kind, plan state). Status colours come from tokens, never raw colours.
- Motion: 0.15 / 0.2 / 0.3 s, ease-out, no overshoot except the small spring on sheets; list stagger capped at 12; `prefers-reduced-motion` is honoured in CSS and in `anim.js`; content is visible before JS.
- Data driven: behaviour from tables and `/api/me`, unknown ids degrade instead of crashing, state in the URL.
- The login page copies the status/chocomail-web layout: logo tile, "Sign in", form on the left, a points panel on the right from 1024 px.
- Differences: Geist is not loaded (system font stack; no font files to ship); `motion` is the vanilla build, not React.
- Rules the status repo does not have and this app adds: 44 px targets, safe-area insets, bottom sheets, no native dialogs.

## Security of the page
- CSP on the HTML: scripts only from our origin, no inline scripts, `frame-ancestors 'none'`. Model and user text is always escaped before markdown; links only `http(s):` and `mailto:` with `rel=noopener`.
- Cookie and same-origin rules: auth-and-modes.md.

## Verified and not verified
- Verified (2026-11-21, headless Firefox 1280x800 and 390x844, scripted against the real server with a fake model): empty state, public chat with streamed markdown, error card, wrong password, successful sign-in, saved chat and sidebar, account and chats sheets, light and dark. A "kitchen sink" render of every turn state (thinking, plan, tool ok/failed, helper, table, code, status, retry, errors, notice) at phone and desktop width. Logic tests in Node.
- **Not verified**: iOS Safari and Android Chrome (keyboard and `visualViewport`, safe areas, drag-to-close with a real finger), installed-PWA mode, the service worker offline path, install prompt, copy buttons on a real clipboard, long-running streams over the Cloudflare tunnel, screen readers. Check these on a phone before relying on them.

## Known gaps
- Thinking text is not stored with saved messages (needs a stored field and stripping it from what is sent to the model).
- No regenerate for saved chats (the server has no "drop last reply" yet); visitors have it.
- No tab bar or edge-swipe drawer: the header buttons open sheets instead.

## Consistency rules (checked by eye on every change; keep them true)
- The header is a 3-column grid (`1fr auto 1fr`): the title is **always centred** in the main pane, whatever buttons are on either side.
- **No control twice on screen.** With the sidebar open (desktop, signed in) "new chat" and the account live in the sidebar and the header only carries the title; with it closed, or on a phone, the header carries menu, new chat and account (`syncChrome` in `app.js`).
- Header and sidebar header have the **same height**, so their bottom lines meet.
- **One hover/press overlay** for every control (`--hover`, `--press`, a translucent layer drawn over whatever background the control has), so buttons, chips, rows, attachment chips and menu rows all react the same way. Hover styles only inside `@media (hover: hover)`.
- Controls inside the pill-shaped composer are **round** (attach, send); the disabled send button is neutral grey, not a faded accent.
- Row actions (the ⋯ button) appear on hover/focus on hover-capable devices and are always visible on touch.
- No sentence appears twice on one screen (the privacy line lives only under the composer).
- Suggestion chips are equal-width grid cells.
- The brand tile is the same teal tile with `icons/mark.svg` (the symmetric chat-bubble mark) in light and dark, everywhere (`.logo`).
