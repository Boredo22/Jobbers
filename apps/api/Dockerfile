# ---------------------------------------------------------------------------
# Dockerfile — the "always-on twin" of the dev API (pre-Phase-8 flavor).
#
# Purpose: run the API unattended so the cron scheduler and scoring worker
# actually fire (twice-daily polls, queue draining, ntfy pings) without a dev
# terminal open. It deliberately runs tsx against the TypeScript source — no
# bundling — because this is the automation container, not the optimized
# production image. Phase 8 replaces this with a tsup multi-stage build.
#
# Build context is the REPO ROOT (see docker-compose.yml), because the api
# depends on the workspace packages (@jobber/shared, @jobber/ai).
# ---------------------------------------------------------------------------
FROM node:22-slim
WORKDIR /app

# corepack reads the "packageManager" field in package.json and provisions the
# exact pnpm version the repo is pinned to — same tool on host and in container.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Manifests first, source later: Docker caches each layer, so `pnpm install`
# only re-runs when a package.json or the lockfile changes — not on every code
# edit. (apps/web's manifest is copied only so pnpm can see the full workspace;
# --frozen-lockfile validates the lockfile against ALL workspace projects.)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/ai/package.json packages/ai/
RUN pnpm install --frozen-lockfile --filter api...

# Now the actual source (a code change only invalidates from here down).
COPY apps/api apps/api
COPY packages packages

# Apply any pending migrations, then start the server. Migrations are
# idempotent (drizzle tracks what's applied), so this is a no-op on most boots.
CMD ["sh", "-c", "pnpm --filter api db:migrate && pnpm --filter api exec tsx src/server.ts"]
