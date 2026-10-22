# syntax=docker/dockerfile:1
# One image for the whole demo: the API serves the built simulator at `/` (WA-020).
# Build:  docker build -t wa-api .
# Run:    docker run --rm -p 8080:8080 -e SIMULATOR_WEBHOOK_SECRET=change-me-please wa-api
ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /repo
# Manifests first, so the dependency layer is reused while only source files change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/simulator/package.json apps/simulator/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
# Builds @wa/shared, then the API (tsc) and the simulator (ng build).
RUN pnpm build
# Production dependencies only, with @wa/shared copied in instead of symlinked.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @wa/api deploy --prod /out/apps/api

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Same layout as the repo, so the default CLIENTS_DIR, SIMULATOR_DIST_DIR and PGLITE_DIR resolve.
COPY --from=build /out/apps/api apps/api
COPY --from=build /repo/apps/simulator/dist/simulator/browser apps/simulator/dist/simulator/browser
COPY clients clients
# Only used when DATABASE_URL is unset (a local `docker run`); Cloud Run always uses Postgres.
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
