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
- Run only the tests your change touches while iterating; run the whole suite once before finishing. Do not delete tests without approval.

---

## Architecture and constraints

- Backend: Python 3 standard library only. Zero pip dependencies. The only allowed system add-on is `poppler-utils` (PDF text).
- Memory target: small (README says about 35 MB idle). `mem_limit` in compose is 256m.
- State: SQLite. Settings are one table in `settings.py`; a new setting is one row.
- Failures: every failure goes through `errors.py` (one table). Never put a raw Python exception string in front of a user.
- Data driven: behaviour comes from tables (settings, error kinds, mode -> tools), not from names in `if` chains.
- Public exposure: the page may be public; anything that runs tools or shell must be behind a login or token.

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
- Related repos: `choc-node-agent` (gateway + node agent, contract in its `docs/ai-gateway.md`), `ChocoHost-status` (dashboard `/ai` page, design rules in its `docs/design-principles.md`), `chocomail-dms` (mail accounts used for login).
