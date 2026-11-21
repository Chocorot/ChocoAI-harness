# The TypeScript rewrite (2026-11-21)

The Python app (`harness.py` and friends, plain-JS page) was replaced in one go by a Next.js 16 / TypeScript app, on Sir's instruction "just direct rewrite, prod no one using rn". The Python code is gone from the tree (it lives in git history before this commit) and there is no rollback image prepared: if it must go back, check out the commit before the rewrite and rebuild.

## Why
- Same components and the same login as status, mail and the SSO (`@chocorot/design`, the Choco SSO), so the AI app looks and behaves like the others.
- Frontend and backend in one app and one container.
- Visitors keep free public chat without signing in. The SSO is only for the signed-in features.

## Layout
- `src/core/`: the engine, **no Next and no React** (relative `.ts` imports, so `node --experimental-strip-types --test` runs it): errors, settings, auth modes, run queue, SQLite, web (SSRF-guarded fetch, search), attachments, tools, automations, model client, agent loop.
- `src/server/`: HTTP glue as plain `(Request) => Response` functions (`api.ts`), session cookie, SSO, SSE, shared state. `src/app/**/route.ts` only wire URLs to these.
- `src/ui/`: the React app. `src/ui/lib/turn.ts` is framework-free like the core.
- Golden fixtures: `test/golden/*.json` were produced **from the Python code** (compaction, SSE parsing, titles, plan steps, history trimming, schedule maths, settings, errors, auth, web helpers, attachments, tool output) and the TypeScript tests compare against them. They are frozen reference snapshots now: the generator went away with the Python code, so a changed golden value is a deliberate behaviour change that needs a reason.

## What was kept (the compatibility contract)
1. Same SQLite schema and file layout: `<data>/users/<uid>/harness.db`, `<workspace>/users/<uid>/<session>/`, original `harness.db`, `settings.json` (+ `.bak`). `uid = sha256(lower(email))[:32]`, so every existing user's chats are still there (once they sign in again with the same address through the SSO).
2. `/manage/*` shapes (manifest, sessions, errors, `PUT settings`, `HARNESS_ADMIN_TOKEN`, 404 when unset): the node agent and the status dashboard's AI page keep working. Not tested against the real node agent.
3. The SSE event protocol, `/task`, `/health`, error kinds and HTTP codes.
4. Env vars `BASE_URL`, `API_KEY`, `MODEL`, `HARNESS_TOKEN`, `HARNESS_ADMIN_TOKEN`, `HARNESS_TZ`, `HARNESS_TRUST_PROXY`, `HARNESS_PUBLIC_URL`, `SEARCH_URL`; compose label `choc.ai.harness`; volumes `harness-data` / `harness-ws`; the searxng service; container uid 1000.
5. Per-user isolation rules (paths only from the verified identity and an integer session id; a foreign or unknown id is the same 404).

## What changed (on purpose)
- **Sign-in**: the SSO replaces the IMAP password check. Roles for client `ai`: `user`, `shell`. New env: `AUTH_SECRET`, `SSO_*`. Removed: `HARNESS_SESSION_KEY`, `HARNESS_SHELL_USERS`, `MAIL_HOST`, `MAIL_PORT`, `HARNESS_INSECURE_COOKIES`. Everyone signs in again (new cookie).
- **The shell** for signed-in users is off unless `HARNESS_SHELL=unconfined` (no sandbox was built). Its environment is scrubbed of server secrets; the Python shell inherited the whole server environment (tokens, keys). That leak is fixed, not carried over.
- **CLI dropped**. Scripts use `POST /task` with the admin token.
- **Memory**: `mem_limit` 512m (was 256m). A Next.js server measured about 100 MB RSS after a few requests, against about 35 MB for the Python one. The "< 20 MB, stdlib only" rules in the old AGENTS.md no longer apply.
- **Static files** are Next's: the strict Content-Security-Policy of the old page is gone (see pwa-and-ui-design.md), `__SITE__` placeholder replaced by `HARNESS_PUBLIC_URL` metadata (branding-and-seo.md).
- The `login_unavailable` message now reads "Sign-in is unavailable right now. Try again shortly." (it used to blame the mail server).
- The brand scene tool (`brand/build.py scenes`) was dropped; `og.png` and the install screenshots show the old UI.

## Test status
- `npm test`: 119 Node tests (core, API with a fake model, SSO with a fake IdP, UI turn model). The Python suite had 134 tests; known not ported: `StaticTests` (file serving, CSP, traversal; Next serves static files now) and the PDF reader's mocked-subprocess test.
- Not run: a real model backend, a real SSO, Docker, the node agent, iOS/Android.
