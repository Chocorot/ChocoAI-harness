# The app UI (PWA) and its design rules

Code: `src/app/` (layout, page, robots, sitemap), `src/ui/` (the React app), `public/` (icons, manifest, `sw.js`).
Tests: `src/ui/lib/turn.test.ts` (event parsing, `<think>` splitting, the turn model, replay of saved chats). The components themselves have no unit tests: they were checked in a real browser (see "Verified").
Built with Next.js 16, Tailwind v4 and the shared `@chocorot/design` package (tokens, `ui/*` components, `shell/*`), the same as status and mail.

## Files
| file | role |
|---|---|
| `src/app/layout.tsx` | metadata (title, description, Open Graph, Twitter, icons, manifest), viewport/theme colours, fonts (Geist), `ThemeProvider`, `MotionProvider`, `TooltipProvider`, toaster, service worker registration |
| `src/app/globals.css` | imports the design tokens and base CSS, tells Tailwind to scan the package, streamed-markdown styles, the shimmer |
| `src/ui/app.tsx` | the controller: who am I, routing (`#/` and `#/c/<id>`), public vs signed-in chat, the run/stream/poll loop, sidebar and dialogs |
| `src/ui/lib/turn.ts` | **no React**: SSE reader, `<think>` splitting, `TurnModel` (one assistant turn as data), `replay` of saved messages, tool/error tables |
| `src/ui/turn-view.tsx` | draws a `TurnModel`: thinking panel, tool cards, plan, status line, notices, error cards |
| `src/ui/markdown.tsx` | `react-markdown` + GFM; code blocks with Copy; links open in a new tab; model-supplied images are never rendered |
| `src/ui/composer.tsx` | message box: attach (button, paste, drop), photo shrinking, effort menu, send/stop |
| `src/ui/chat-list.tsx`, `automations.tsx`, `account.tsx` | the chat list (sidebar and phone sheet), the automations dialog, the account dialog |
| `src/ui/lib/api.ts` | `api()` fetch helper, `Me` type, attachment limits, `store` (localStorage that never throws) |
| `src/ui/icons.ts` | the icon names the turn model uses -> lucide icons |
| `public/sw.js`, `public/manifest.webmanifest`, `public/icons/` | installable app + offline shell |

## What the page does
- **Built from `/api/me`**: `capabilities.history` (`client` = visitor, `user` = saved chats), `tools`, `login`, `automations`, `attachments`. No tier or tool names in the logic. Suggestion chips need a tool (`needs`), tool cards come from `TOOL_UI`, error icons from `ERROR_ICON` (both tables in `lib/turn.ts`); an unknown tool or error kind still renders (generic card).
- **State in the URL**: `#/` new chat, `#/c/<id>` a saved chat. Sign-in is a full-page trip to the SSO (`/api/auth/sso/start`); the page then reads `?signin=denied|error` once and shows a toast.
- **Visitor**: one chat kept in `localStorage` (`choco.public.chat.v1`, last 100 messages); Reset is in the Account dialog (second press confirms). The page sends its history on every request. A failed attempt leaves a hidden note in that history for the model (errors.md).
- **Signed in**: chat list (sidebar from 768 px, Chats dialog on phones), open, rename in place, delete (confirm dialog), new chat. Saved chats replay messages, tool calls, results and plans (thinking text is not stored, so reloaded chats show no thinking panel).
- **Attachments** (signed in, when `/api/me` says so): paperclip, paste, drag and drop; chips above the composer; the sent message shows the photo and document chips; saved chats load them back from `/api/sessions/<id>/uploads/...` (attachments.md).
- **Automations** (when `/api/me` says `automations`): an Automations button above the chat list opens a dialog with the list (name, schedule, next/last run, on/off switch, Run now, Last result, Delete) and a form (name, prompt, Repeat or Daily). See automations.md.
- **Effort**: a three-bar button in the composer opens Low / Medium / High (chats.md).
- **Streaming**: events go into the `TurnModel` and the page redraws at most once per animation frame; the markdown component is memoised so only changed text re-renders; auto-scroll sticks only while the reader is near the bottom, and a "Latest" button appears when scrolled up.
- **Thinking panel**: shimmer label with a live timer, open while reasoning streams, folds to "Thought for Ns" when the answer starts (unless the user toggled it). Reasoning written inline as `<think>...</think>` is handled too.
- **Tool cards**: running / ok / failed with elapsed time; failures open by themselves. Helper output (`sub` events) is nested inside the Helper card. `update_plan` is shown as a live checklist instead of a card.
- **Status line**: waiting in line (N ahead), thinking step, retrying with a countdown. **Notices** (budget stops) have a Continue button. **Error cards** show the plain message, the reference id and Try again when retryable.
- **Connection dropped** (phone backgrounded): for a saved chat the page polls `GET /api/sessions/<id>` every 2.5 s until `running` is false and then reloads it; a visitor gets an error card with Try again.
- Stop aborts the request. For a saved chat the run may still finish on the server; the page then catches up.
- The chat answer is a server-sent event stream, so `next.config.ts` sets `compress: false` (gzip would hold the stream back).

## App-feel rules (so it does not feel like a website)
- The page never scrolls: `html, body { overflow: hidden; overscroll-behavior: none }`, the app is `100dvh` (or the visual viewport height while the keyboard is open, set from `visualViewport`). Only the message list and dialogs scroll.
- Composer is pinned at the bottom with `env(safe-area-inset-bottom)`; the textarea is `text-base` (16 px, so iOS does not zoom on focus); Enter sends on desktop, inserts a newline on touch devices (`pointer: coarse`).
- Desktop sidebar (signed in): the menu button in the header closes/opens it and the choice is remembered (`choco-harness-sidebar`). On a phone the same button opens the Chats dialog.
- No native `alert/confirm/prompt`: confirm dialogs, second-press buttons and toasts instead.
- Installable: manifest (`display: standalone`), icons, `apple-mobile-web-app-*` tags (from the Next metadata), service worker (`public/sw.js`: network first, cache as offline fallback; `/api`, `/manage` and `/task` never cached; registered in production only). The Account dialog shows Install when the browser offers it, and a hint on iOS.
- Code blocks and tables scroll sideways inside their own box.

## Design rules: the shared Choco design
Source of truth: repo `ChocoHost-Design` (`@chocorot/design`), its `docs/design-rules.md` and `docs/tokens.md`. status, mail, the SSO and this app use the same package.
- Tokens and base CSS come from the package (`globals.css` imports them). **Never add or override a shared token here**; change it in the design repo. Components come from `@chocorot/design/ui/*` and the header from `@chocorot/design/shell/app-header`.
- The brand tile is `BrandMark` with a lucide `Sparkles` icon (the header and the empty state); the app icons and favicon are the shared brand set, installed into `public/icons` (branding-and-seo.md).
- Theme (System / Light / Dark) is the shared `ThemeProvider` (`next-themes`, class strategy, key `choco-theme`, plus a `choco-theme` cookie on `.chocorot.net` so the choice follows you between the sites).
- Colour is never the only signal (icons on tool state, error kind, plan state). Status colours come from tokens, never raw colours.
- Motion comes from the package (`MotionProvider`, reduced motion honoured). Content is visible without it.
- Data driven: behaviour from tables and `/api/me`, unknown ids degrade instead of crashing, state in the URL.

## Security of the page
- Model and user text is rendered by `react-markdown` without raw HTML; links are http(s)/mailto only (library default) with `rel=noopener noreferrer`; model-supplied images are dropped.
- `next.config.ts` adds `X-Content-Type-Options`, `X-Frame-Options: DENY` and `Referrer-Policy` to every response. **There is no Content-Security-Policy on the pages** (the old plain-JS page had a strict one; Next's inline hydration scripts need a nonce setup that is not built). Uploaded files are still served with `default-src 'none'; sandbox`.
- Cookie and same-origin rules: auth-and-modes.md.

## Verified and not verified
- Verified (2026-11-21, headless Chromium against `next start` and the standalone server, with a fake OpenAI-compatible model): empty state; public chat with streamed markdown and code block; history restored after reload; error card; signed-in chat (a session cookie minted with `AUTH_SECRET`, not through the SSO); tool call card with a failed result; rename in place; reopen from the sidebar; delete with confirm; effort menu; automations dialog opens; attachment (.txt) round trip and replay without the wrapper text; Stop; light and dark; 390 px phone width for the Chats and Account dialogs.
- **Not verified**: a real sign-in through the SSO; iOS Safari and Android Chrome (keyboard and `visualViewport`, safe areas); installed-PWA mode, the service worker offline path, the install prompt; the "connection lost, reconnecting" poll path; photos (vision is off by default); long streams over the Cloudflare tunnel; screen readers; the automations form and scheduler through the UI (the API and scheduler are tested in Node).

## Known gaps
- Thinking text is not stored with saved messages (needs a stored field and stripping it from what is sent to the model).
- No regenerate for saved chats (the server has no "drop last reply" yet); visitors have it.
- The chat title is a thin line under the header, not in the header (the shared `AppHeader` has no title slot).
- The install-dialog screenshots and the social preview image still show the previous UI (branding-and-seo.md).
