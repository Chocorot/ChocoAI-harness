# Auth and modes

Code: `auth.py` (cookie, IMAP check, `MODES`, throttles), `harness.py` (`_who`, `_login`, `_chat`, `_chat_public`, `_run`).
Tests: `AuthUnitTests`, `ModesTests` in `test_harness.py`.

## Who is calling (`H._who`)
1. `Authorization: Bearer $HARNESS_TOKEN` -> **admin** (CLI / scripts; the original DB and workspace).
2. A valid `choco_harness` cookie -> **user**, or **user+shell** if the address is in `HARNESS_SHELL_USERS`.
3. Anything else -> **public**.

## The mode table (`auth.MODES`)
| mode | tools | chat stored | queue priority |
|---|---|---|---|
| admin | read_file, edit_file, write_file, run_bash | original `harness.db` | 0 |
| user+shell | all four | the user's own DB | 1 |
| user | read_file, edit_file, write_file (inside their session dir) | the user's own DB | 1 |
| public | none | in the visitor's browser | 2 |

A new tier = a new row. Tools are limited twice: the schemas sent to the model, and `tools.run(..., allow=)` when a call comes back (a model that asks for `run_bash` anyway gets `error[forbidden]`).
`run_bash` is **not a sandbox**: it runs as the container user and can read other users' directories. That is why it is for the allowlist (trusted admins) only.

## Sign-in
- `POST /api/login {"email","password"}`: checks the password by logging in to the DMS mailbox over IMAP (`MAIL_HOST` default `mail.chocorot.net`, `MAIL_PORT` 993, TLS verified, 10 s timeout) and logs straight out. Any mailbox on the server can sign in.
- Wrong password and unknown mailbox give the same answer (`Incorrect email or password.`). Mail server unreachable: 503 `login_unavailable`.
- The password is never stored and never put in the cookie. The cookie holds the address and an expiry, signed with HMAC-SHA256 using `HARNESS_SESSION_KEY` (16+ characters). Changing the key signs everybody out.
- Cookie: `HttpOnly; SameSite=Lax; Path=/; Max-Age=30 days`, plus `Secure` unless `HARNESS_INSECURE_COOKIES=1` (local http dev; Safari refuses Secure cookies on http://localhost).
- No `HARNESS_SESSION_KEY` (or under 16 characters) = sign-in is off (`/api/login` is 404, `/api/me` says `login:false`); everybody is public.
- Throttles (in memory, reset on restart): 5 wrong passwords per address and 20 per IP per 10 minutes -> 429 `rate_limited` (a correct password also waits).
- POSTs and DELETEs on `/api/*` with an `Origin` that is not our own host are refused (403), on top of SameSite.
- `POST /api/logout` clears the cookie.

## Endpoints
| | |
|---|---|
| `GET /api/me` | `{mode, address, capabilities:{login, tools[], shell, history}}`: the page builds itself from this |
| `POST /api/login`, `POST /api/logout` | see above |
| `POST /api/chat` | public: `{"messages":[{role,content}...]}`; signed in: `{"goal","session","retry"}`. Streams by default |
| `GET /api/sessions`, `GET /api/sessions/<id>`, `DELETE /api/sessions/<id>` | the caller's own chats (401 for visitors) |
| `POST /task` | admin only, needs `HARNESS_TOKEN`; **no token set = the endpoint does not exist (404)** |

## Public chat
- The page sends its whole history each time (stateless server). Roles `user`/`assistant` only, last must be `user`, extra keys dropped.
- Limits (settings, live): `public_rpm` requests per minute per IP (default 6), `public_max_chars` history size (24000; older messages are dropped and a `trimmed` event says how many), `public_max_tokens` reply cap (1024), `max_queue_public` visitors allowed to wait (2, shorter than the main line so signed-in users still get in), `public_prompt`.
- No tools, nothing stored on the server. On failure the `error` event carries `note`, which the page keeps in its history (see errors.md).
- Client IP: the socket address, or `CF-Connecting-IP` / `X-Forwarded-For` only when `HARNESS_TRUST_PROXY=1`. Set it only when every request comes through your own tunnel/proxy (the compose file publishes on 127.0.0.1 only), otherwise anyone can fake their IP and dodge the limit. Without it, all visitors behind the tunnel share one IP and one rate limit.

## Environment
| var | meaning |
|---|---|
| `HARNESS_SESSION_KEY` | cookie signing key, 16+ chars. Required for sign-in |
| `HARNESS_SHELL_USERS` | comma-separated addresses that get `run_bash` |
| `MAIL_HOST`, `MAIL_PORT` | IMAP server for sign-in |
| `HARNESS_TOKEN` | enables `/task` and the admin mode |
| `HARNESS_TRUST_PROXY`, `HARNESS_INSECURE_COOKIES` | see above |
| `HARNESS_OPEN` | **removed**: the host/token start-up guard is gone because `/task` now refuses to exist without a token |

## Not done yet
- The page (`index.html`) is still the old one and only speaks `/task` with a token. Visitors cannot use public chat from it until the frontend rewrite (phase 4).
- Whether `mail.chocorot.net:993` is reachable from the harness host is not checked. Run one real sign-in after deploying.
