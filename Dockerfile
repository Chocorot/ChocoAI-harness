# ChocoAI harness: one Next.js container (UI + API + scheduler). Same volumes and uid (1000) as the Python image it replaces,
# so /data (per-user SQLite files) and /workspace carry over untouched.
#
# DEBIAN SLIM, NOT ALPINE: better-sqlite3 is a native addon with glibc prebuilt binaries (see chocomail-web/Dockerfile).

# ---------- deps ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# toolchain only as a fallback when no prebuilt better-sqlite3 binary matches; this stage is discarded
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
# @chocorot/design is a private GitHub Packages package. The token is a BuildKit secret, never written to a layer:
#   docker build --secret id=gh_packages_token,env=GH_PACKAGES_TOKEN .
RUN --mount=type=secret,id=gh_packages_token \
    GH_PACKAGES_TOKEN="$(cat /run/secrets/gh_packages_token)" npm ci

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0 \
    HARNESS_DB=/data/harness.db HARNESS_WORKSPACE=/workspace
# poppler-utils: pdftotext, so users can attach PDFs (docs/attachments.md); tzdata: HARNESS_TZ for automations (docs/automations.md);
# tini: signals and zombies (the shell tool spawns processes).
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tzdata tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /data /workspace && chown node:node /data /workspace
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
VOLUME ["/data", "/workspace"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
