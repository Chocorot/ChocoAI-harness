# Deploy

Code: `Dockerfile`, `docker-compose.yml`, `.github/workflows/deploy.yml`, `next.config.ts` (`output: 'standalone'`).

## Image
- `node:22-bookworm-slim`, three stages (deps, build, runtime), Next standalone output, `tini` as init, user `node` (uid 1000, the same uid as the old Python image, so the `harness-data` and `harness-ws` volumes carry over).
- Runtime packages: `poppler-utils` (PDF text), `tzdata` (`HARNESS_TZ`), `ca-certificates`.
- `@chocorot/design` is a private GitHub Packages package. The build needs a token with `read:packages` as the BuildKit secret `gh_packages_token`:
  `GH_PACKAGES_TOKEN=... docker build --secret id=gh_packages_token,env=GH_PACKAGES_TOKEN -t choco-harness .`
  The token is never written to a layer. CI reads it from the repository secret `GH_PACKAGES_TOKEN`.
- Defaults baked in: `HARNESS_DB=/data/harness.db`, `HARNESS_WORKSPACE=/workspace`, `PORT=8080`, `HOSTNAME=0.0.0.0`. Health check: `GET /health`.
- **Not run here**: there is no Docker on the dev Mac. The standalone output was started by hand (`node server.js` from a copy of `.next/standalone` with `.next/static` and `public`) and served `/`, `/health`, `/api/me`, icons and robots. The image itself, `poppler-utils` in it, and the native `better-sqlite3` binary on Linux are first exercised by the CI smoke test.

## CI/CD
- `deploy.yml` on push or pull request to `main`: `npm ci`, `typecheck`, `npm test`, `npm run build`. On push only: build the image locally, boot it and curl `/health`, `/api/me` and `/`, then push `ghcr.io/chocorot/choco-harness:latest` and `:sha-<commit>`.
- On the server, `docker-compose.yml` runs `:latest` with the watchtower label, so watchtower (polls every 5 min) pulls and restarts it. No SSH secrets. Roll back by pinning the compose image to a `sha-<commit>` tag.
- One-time server setup: copy `docker-compose.yml` **and the `searxng/` folder** next to `.env` in `~/ChocoAI-harness/`, add `SEARXNG_SECRET=<random>`, then `docker compose up -d`. Watchtower only updates images: a changed compose file or `searxng/settings.yml` must be copied by hand.

## `.env` on the server
| var | |
|---|---|
| `BASE_URL`, `API_KEY`, `MODEL` | the model backend (OpenAI-compatible) |
| `HARNESS_TOKEN` | enables `/task` (admin scripts) |
| `HARNESS_ADMIN_TOKEN` | enables `/manage/*` (the dashboard through the node agent) |
| `AUTH_SECRET` | session cookie key: `openssl rand -hex 32` |
| `SSO_ISSUER`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `SSO_REDIRECT_URI` | the Choco SSO client `ai` (`SSO_REDIRECT_URI` = `https://<site>/api/auth/sso/callback`) |
| `HARNESS_PUBLIC_URL` | `https://<site>` for canonical, preview and sitemap |
| `SEARXNG_SECRET` | for the searxng service |
| `HARNESS_SHELL` | leave unset; `unconfined` gives the SSO role `shell` the shell (auth-and-modes.md) |

Compose already sets `SEARCH_URL`, `HARNESS_TRUST_PROXY=1` (the port is published on 127.0.0.1 only; every request comes through the tunnel) and `HARNESS_TZ` is optional.

`.env.example` lists every variable. For `ai.chocorot.net` the new lines are: `AUTH_SECRET` (generate), `SSO_ISSUER=https://account.chocorot.net`, `SSO_CLIENT_ID=ai`, `SSO_CLIENT_SECRET` (printed once by `create-client`), `SSO_REDIRECT_URI=https://ai.chocorot.net/api/auth/sso/callback`, `HARNESS_PUBLIC_URL=https://ai.chocorot.net`.

Who may sign in is not an env var: it is the setting `allowed_users`, edited in the status dashboard (auth-and-modes.md).

## What to register in the SSO for this app
`create-client ai ChocoAI https://ai.chocorot.net/api/auth/sso/callback https://ai.chocorot.net/ https://ai.chocorot.net/api/auth/sso/backchannel-logout user,shell` (redirect URI, post-logout URI, back-channel logout URL, assignable roles). For an existing client: `set-backchannel ai <url>` and `set-client-roles ai user,shell`. Without the back-channel URL the app is simply not told about sign-outs elsewhere. The SSO must be able to reach the URL (the SSO runs on Vercel, the harness behind the Cloudflare tunnel).

## Order of go-live (needs Sir)
1. The SSO is deployed and has the client `ai` (redirect URI above, roles `user`, `shell`); its secret goes into `.env`.
2. Users get the role `user` for `ai` in the SSO (no role = "not allowed").
3. Push to `main`, wait for CI, let watchtower pull. Check `docker logs choco-harness` and sign in once.
4. The node agent finds the container through the label; check the dashboard's AI page still loads the manifest.

## Local run
```bash
npm ci   # needs GH_PACKAGES_TOKEN in the environment (.npmrc reads it)
BASE_URL=http://localhost:1235/v1 AUTH_SECRET=$(openssl rand -hex 32) npm run dev
npm test
```
Without `SSO_*` everybody is a visitor (public chat). To try the signed-in screens without an SSO, mint a session cookie with `sealSession(newSession(address, ['user']))` from `src/server/session.ts`.
