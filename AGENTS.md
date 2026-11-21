# Working on ChocoAI-harness

## How to talk to me

- Point form, plain language. No long paragraphs.
- **Say "Sir" in every reply.** It is a canary: if it is missing, you have lost these instructions and should stop and re-read them.
- Ask when you do not have the context. Never assume.
- Tell me plainly when something is broken, unfinished, or was already broken before you touched it. Do not soften it.

---

## Documentation rule

- **Read first, always**: before any task (even a small one) read `README.md` and the matching file in [`docs/`](docs/README.md).
- **Update in the same change**: any change to behavior, API, settings, env vars or UI updates the matching doc in the same commit. A stale doc is worse than none.
- Docs are split by feature in `docs/`. No giant log file. Learned something the hard way: write it down there.
- Run only the tests your change touches while iterating (`node --experimental-strip-types --test src/core/x.test.ts`); run `npm test`, `npm run typecheck` and `npm run build` once before finishing. Do not delete tests without approval.

---

## Architecture and constraints

- Stack: Next.js 16 + TypeScript, one container (UI, API, scheduler). Rewritten from Python on 2026-11-21 ([docs/ts-rewrite.md](docs/ts-rewrite.md)); no Python is left.
- Layers: `src/core/` is the engine and must not import Next, React or anything from `src/server` / `src/ui` (relative `.ts` imports, so the Node test runner loads it). `src/server/` is HTTP glue as `(Request) => Response`; `src/app/**/route.ts` only wire URLs to it. `src/ui/` is the React app (`src/ui/lib/turn.ts` stays framework-free).
- Look and feel: only `@chocorot/design` (tokens, `ui/*`, `shell/*`). Never add or override a shared token here; change it in the ChocoHost-Design repo. Login is the Choco SSO (OIDC client).
- Few dependencies. Adding one needs a reason (the core uses `better-sqlite3`, `fflate`, `jose`).
- Memory: about 100 MB RSS measured; `mem_limit` in compose is 512m.
- State: SQLite, one file per user (docs/storage-isolation.md). Settings are one table in `src/core/settings.ts`; a new setting is one row.
- Failures: every failure goes through `src/core/errors.ts` (one table). Never put a raw exception string in front of a user.
- Data driven: behaviour comes from tables (settings, error kinds, mode -> tools, tool UI), not from names in `if` chains.
- Public exposure: the page may be public; anything that runs tools or shell must be behind a login or token. The shell for users is off unless `HARNESS_SHELL=unconfined`.
- `test/golden/*.json` are frozen outputs of the old Python code. Change one only on purpose, and say why.
- Pushing to `main` builds `:latest` and watchtower deploys it: never push for me (see below).

---

## Committing: I do it, not you

Never run `git commit`. Instead:

1. Stage the change (`git add`).
2. Write the commit message out **in chat**, as plain text I can copy. Not in a file, not in a tool result.
3. Ask whether I committed (AskUserQuestion if available, otherwise in chat). Answers: "I have commited", "I did not commit", "I dont want to commit now". **Put the full commit message inside the question text too.**

If I say I did not commit, or not now, leave it staged and keep working on top.

---

## Working across repos

My sessions often touch several repos at once, and only this repo's rules load by default.

- Say which repo each change is for.
- Before changing another repo, read its `AGENTS.md` first. Do not apply this repo's rules there.
- Related repos: `choc-node-agent` (gateway + node agent, contract in its `docs/ai-gateway.md`), `ChocoHost-status` (dashboard `/ai` page, design rules in its `docs/design-principles.md`), `ChocoHost-SSO` (the login; client `ai`), `ChocoHost-Design` (`@chocorot/design`), `chocomail-dms` (mail server; the SSO syncs passwords into it).
