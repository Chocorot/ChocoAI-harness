# Auth and modes

Code: `src/core/auth.ts` (`MODES`, `modeForRoles`, throttles, storage paths), `src/server/session.ts` (the session cookie), `src/server/sso.ts` + `src/server/auth-routes.ts` (the Choco SSO round trip), `src/server/http.ts` (`who`, `needUser`, `sameOrigin`, `clientIp`), `src/server/api.ts`, `src/server/chat.ts`.
Tests: `src/core/auth.test.ts`, `src/server/sso.test.ts`, `src/server/api.test.ts` (modes, isolation, public chat).

## Who is calling (`http.who`)
1. `Authorization: Bearer $HARNESS_TOKEN` on `/task` -> **admin** (scripts; the original DB and workspace).
2. A valid session cookie -> **user**, or **user+shell** (see "The shell" below).
3. Anything else -> **public**.

## The mode table (`auth.MODES`)
| mode | tools | chat stored | queue priority |
|---|---|---|---|
| admin | all tools: files, run_bash, web_fetch, web_search, update_plan, delegate | original `harness.db` | 0 |
| user+shell | all tools | the user's own DB | 1 |
| user | files (inside their session dir), web_fetch, web_search, update_plan, delegate (no shell) | the user's own DB | 1 |
| public | none | in the visitor's browser | 2 |

A new tier = a new row. Tools are limited twice: the schemas sent to the model, and `tools.run(..., allow)` when a call comes back (a model that asks for `run_bash` anyway gets `error[forbidden]`).

## The shell (`run_bash`)
- It is **not a sandbox**: it runs as the container user and can read other users' directories (storage-isolation.md). Its environment is scrubbed (`PATH`, `HOME`=the session dir, `LANG`, `TERM`, `PWD` only), so it cannot read the server's tokens and keys from its environment, and it runs in its own process group so a timeout kills what it started.
- Who gets it: **admin** always (`/task`). A signed-in user gets it only when the SSO gives them the role `shell` for this app **and** the operator set `HARNESS_SHELL=unconfined`. Without that variable the `shell` role is just a user. The default is off because there is no sandbox yet (a sandbox such as bubblewrap was not tried; Docker's default seccomp profile most likely blocks it).

## Sign-in: the Choco SSO (OIDC)
- **Account settings are at the SSO**: `/api/me` carries `capabilities.accountUrl` (`SSO_ISSUER/account`) and the Account dialog has an "Account settings" button (opens in a new tab) for a signed-in person; name, password and signed-in devices are never handled here.
- **Silent sign-in**: `/api/me` carries `capabilities.silentLogin` (SSO configured, visitor, no `choco_ai_silent` cookie). The page then goes once to `/api/auth/sso/start?silent=1&next=...` (the flow cookie remembers `silent`; the authorize URL has `prompt=none`). A code signs in as usual; ANY other answer (`login_required`, `interaction_required` for the shell role, `access_denied`, `account_selection_required`) is quiet: no toast, the browser returns to `next` as a visitor and `choco_ai_silent` (10 minutes, `src/server/silent.ts`) stops it asking again for a while. Not asked right after a failed sign-in, and `/api/logout` sets the cookie so signing out never signs straight back in. Cost: one quick hop to the SSO and back for a visitor, at most every 10 minutes.
- Visitors stay anonymous; only signed-in features need the SSO. The page's "Sign in with Choco" button (in the Account dialog; there is no separate login page, one click goes straight to the SSO) goes to `GET /api/auth/sso/start`, which stores `state`, `nonce` and the PKCE verifier in a short-lived encrypted cookie (`choco_ai_sso_flow`, 10 min) and redirects to the SSO. The SSO returns to `GET /api/auth/sso/callback?code&state`; the app checks `state`, the `iss` parameter (RFC 9207), exchanges the code (PKCE S256), verifies the EdDSA ID token (issuer, audience, nonce, signature from the SSO's JWKS) and reads the `roles` claim for this client. `amr` must have `pwd`; the authenticator code (`otp`) is only asked for the **`shell` role** (the SSO enforces it, ChocoHost-SSO `docs/oidc.md`). As a second lock, a token whose roles include `shell` but whose `amr` has no `otp` signs the person in as a plain `user` (never as a shell) and logs `[sso] shell role dropped`.
- **Where the browser is sent back to** (after sign-in, or on `?signin=...`) is the public site address (`http.ts` `siteUrl`: `HARNESS_PUBLIC_URL`, else the `Host` header, `https` only with `HARNESS_TRUST_PROXY=1`), never `new URL(req.url).origin`: inside the container that is the bind address `http://0.0.0.0:8080` (the bug of 2026-11-21: sign-in ended on `0.0.0.0`). Set `HARNESS_PUBLIC_URL` in production.
- Roles for client `ai`: `user` (saved chats, tools, automations) and `shell` (see above). No role = `/?signin=denied`. Every other failure = `/?signin=error` (one generic message; the reason goes to the log).
- The app keeps its **own** session: an encrypted cookie (JWE, A256GCM, `jose`) named `__Host-choco-ai` in production (`choco-ai` otherwise), `HttpOnly; SameSite=Lax; Path=/; Secure` (production), 12 hours, holding the address, the roles, the SSO's `sid` and `sub`, the start time and the ID token (only used to sign out). The mode is derived from the roles on every request. No password ever reaches this app.
- `AUTH_SECRET` (64 hex characters or 32 bytes base64) is the cookie key. Changing it signs everybody out. Without it, or without the `SSO_*` variables, sign-in is off (`/api/me` says `login:false`; everybody is public).
- **Signing out signs out of every Choco app.** `POST /api/logout` clears our cookie and returns `{ok, next}`; the page then goes to `next`, the SSO's `/logout?id_token_hint=...&post_logout_redirect_uri=<site>/` (the ID token is kept in the session for this). The SSO ends its session, tells every other app (back-channel logout) and sends the browser back to `/`. `next` is null for a session without an ID token (older cookie) or when sign-in is off: then only our cookie is cleared. Register `https://ai.chocorot.net/` as the client's post-logout URI.
- **Back-channel logout (receiver)**: `POST /api/auth/sso/backchannel-logout` (`src/server/backchannel.ts`). The SSO calls it when this sign-in ends anywhere: sign-out in another app or the SSO, password change, authenticator reset, disable, or a change of the user's `ai` roles. It checks the logout token (SSO signature via its JWKS, `iss`, `aud` = `ai`, header `typ: logout+jwt`, the back-channel event, no `nonce`, `iat` under 5 minutes old, `jti` not seen before, a `sid` or `sub`) and refuses anything else with 400. A good one stores `sid:<sid>` (or `sub:<sub>` = every session of that user that started before it) in the table `revocations` of the original `harness.db` for 13 hours; `who()` (`http.ts`) checks it on EVERY request, so the sign-in stops working on its next request. Register the URL in the SSO: `set-backchannel ai https://ai.chocorot.net/api/auth/sso/backchannel-logout`.
- Limit: if the harness is down when the SSO sends the token, that session lives until it expires (12 h). There is no retry.
- Tests: `src/server/backchannel.test.ts`.
- POSTs, PATCHes and DELETEs on `/api/*` with an `Origin` that is not our own host are refused (403), on top of SameSite.
- **Everyone has to sign in again after the 2026-11-21 rewrite**: the old `choco_harness` cookie (signed with `HARNESS_SESSION_KEY`) is not read any more.

## Who may sign in: the `allowed_users` setting (edited in the status dashboard)
- A harness setting (text, optional), so it shows up in the status site's AI page (harness detail, settings form) with no dashboard change, like every setting (README, "Settings and the manage API").
- One entry per line (commas and spaces also work): an email address, or `@domain` for every address of that domain. Case does not matter. A bad entry is refused when saving, with its name in the message.
- **Empty (the default) = everyone the SSO lets in.** With a list, only listed addresses are signed in; everybody else is a visitor.
- It is checked at the callback (an unlisted user gets `/?signin=denied`) **and on every request** (`http.ts` `who`), so taking someone off the list shuts them out on their next request, not when their 12-hour cookie expires. Their saved chats stay on disk and come back if they are added again. Admin (`/task`) is not affected.
- It narrows, it does not widen: the SSO still refuses users with no role for `ai` before the harness ever sees them (`grant <email> ai user`). So today a new person needs the SSO role **and** to be on the list (if a list is set). To make the list the only live gate, give every SSO user the role `user` for `ai` once; an SSO "open client" option that does this was not built.
- Careful: a list that does not include your own address locks you out of the signed-in features (the status dashboard still works to fix it).
- Tests: `auth.test.ts` (parsing, domains), `settings.test.ts` (validation, manifest), `api.test.ts` (shut out on the next request). The callback's own `denied` branch is not covered by a test.

## Endpoints
| | |
|---|---|
| `GET /api/me` | `{mode, address, capabilities:{login, tools[], shell, history, effort:{default, levels[]}, automations, timezone, attachments:{image, documents[]}}}`: the page builds itself from this |
| `GET /api/auth/sso/start`, `GET /api/auth/sso/callback`, `POST /api/logout`, `POST /api/auth/sso/backchannel-logout` | see above |
| `POST /api/chat` | public: `{"messages":[{role,content}...]}`; signed in: `{"goal","session","retry","attachments","effort"}` (attachments.md, chats.md). Streams by default |
| `PATCH /api/sessions/<id>` | rename (`title`) and/or set thinking `effort` (chats.md) |
| `GET /api/sessions`, `GET /api/sessions/<id>`, `GET /api/sessions/<id>/uploads/<name>`, `DELETE /api/sessions/<id>` | the caller's own chats (401 for visitors) |
| `GET/POST/PATCH/DELETE /api/automations[/<id>[/run]]` | the caller's scheduled prompts (automations.md) |
| `POST /task` | admin only, needs `HARNESS_TOKEN`; **no token set = the endpoint does not exist (404)** |
| `/manage/*` | the dashboard's admin API, its own token (README) |

## Public chat
- The page sends its whole history each time (stateless server). Roles `user`/`assistant` only, last must be `user`, extra keys dropped.
- Limits (settings, live): `public_rpm` requests per minute per IP (default 6), `public_max_chars` history size (24000; older messages are dropped and a `trimmed` event says how many), `public_max_tokens` reply cap (1024), `max_queue_public` visitors allowed to wait (2, shorter than the main line so signed-in users still get in), `public_prompt`.
- No tools, nothing stored on the server. On failure the `error` event carries `note`, which the page keeps in its history (see errors.md).
- Client IP: the socket address, or `CF-Connecting-IP` / `X-Forwarded-For` only when `HARNESS_TRUST_PROXY=1`. Set it only when every request comes through your own tunnel/proxy (the compose file publishes on 127.0.0.1 only), otherwise anyone can fake their IP and dodge the limit. Without it, all visitors behind the tunnel share one IP and one rate limit.

## Environment
| var | meaning |
|---|---|
| `AUTH_SECRET` | session cookie key (64 hex or 32 bytes base64). Required for sign-in |
| `SSO_ISSUER`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `SSO_REDIRECT_URI` | the Choco SSO client for this app (`SSO_REDIRECT_URI` = `<public url>/api/auth/sso/callback`) |
| `HARNESS_SHELL` | `unconfined` lets the SSO role `shell` use `run_bash` |
| `HARNESS_TOKEN` | enables `/task` and the admin mode |
| `HARNESS_ADMIN_TOKEN` | enables `/manage/*` |
| `HARNESS_TRUST_PROXY` | trust `X-Forwarded-*` / `CF-Connecting-IP` (see above) |
| `HARNESS_PUBLIC_URL` | the site address for canonical/OG/sitemap (branding-and-seo.md) |
| `HARNESS_TZ` | time zone name for daily automations (default UTC) |
| `HARNESS_DB`, `HARNESS_WORKSPACE` | where the data and the workspaces live (`/data/harness.db`, `/workspace` in Docker) |
| `HARNESS_KEEPALIVE` | seconds between `: ka` lines (default 10; tests use a small value) |
| removed in the rewrite | `HARNESS_SESSION_KEY`, `HARNESS_SHELL_USERS`, `MAIL_HOST`, `MAIL_PORT`, `HARNESS_INSECURE_COOKIES`, `HARNESS_OPEN` |

## Not checked yet
- A real sign-in against the deployed SSO (needs the SSO deployed, the `ai` client created and its secret in `.env`). The round trip is covered by tests with a fake SSO (`sso.test.ts`).
