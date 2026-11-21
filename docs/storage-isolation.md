# Storage and user isolation

Code: `src/core/auth.ts` (`uid`, `dbPath`, `sessionWs`), `src/server/api.ts` (`withUserDb`, `sessionDelete`), `src/server/chat.ts`, `src/core/db.ts`.
Tests: `src/core/auth.test.ts`, `src/server/api.test.ts` (users cannot see, touch or resume each other's sessions; a chat is stored in the user's own DB and workspace).

## Layout
- Signed-in user: `<dir of HARNESS_DB>/users/<uid>/harness.db`, one SQLite file per user, with the usual tables (sessions, messages, usage, audit, automations).
- Their files: `<workspace>/users/<uid>/<session id>/`, one directory per session. Tools run with that directory as the workspace, and file tools reject paths outside it.
- `uid` = first 32 hex chars of SHA-256 of the lower-cased address. Nothing about the address is guessable from a path, and no path is ever built from request input (only from the cookie's address and an integer session id).
- Admin (bearer token) and legacy data stay in the original `harness.db` and workspace root. Users can never reach them.

## Why a file per user
- Every lookup runs against the caller's own DB. There is no query that could forget a `WHERE user=?`: another user's rows are not in the file that is open.
- A foreign or unknown session id gets the same 404 as one that never existed, for read, resume (`/api/chat`) and delete.
- Session ids are small integers per user (user A and user B can both have session 1). That is safe because of the above; the ids are not secrets.
- `DELETE /api/sessions/<id>` deletes the rows and the session directory.

## Limits (be honest)
- `run_bash` (admin, and users with the SSO role `shell` only when `HARNESS_SHELL=unconfined`) is not confined: it can read other users' files and the data volume. Its environment is scrubbed of the server's secrets (auth-and-modes.md). Everyone else only gets path-confined file tools (paths are resolved with `realpath`, so a symlink inside a session folder does not escape it).
- Each chat row also holds `title`, `title_state` and `effort` (chats.md).
- Thinking text is not stored yet (the TypeScript rewrite did not add it either).
- No quota per user for disk or number of sessions yet.
- The original `harness.db` is not migrated; the manage API (`/manage/*`) still only sees it. Per-user chats are invisible to the dashboard (stats, sessions, errors list) except server errors, which are logged globally.
