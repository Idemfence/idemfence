# syntax=docker/dockerfile:1
# Build context is the repository root (see compose.yaml), because the app is a workspace
# package that depends on idemfence from the same repository.

# node:24.21.0-bookworm-slim, pushed 2026-10-06; pinned by manifest-list digest.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
ENV CI=true
RUN corepack enable
WORKDIR /repo

# Full install (dev dependencies included) to compile TypeScript.
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages/idemfence/package.json packages/idemfence/tsconfig.json packages/idemfence/
COPY packages/conformance/package.json packages/conformance/tsconfig.json packages/conformance/
COPY reference-app/package.json reference-app/tsconfig.json reference-app/
RUN pnpm install --frozen-lockfile
COPY packages/idemfence/src packages/idemfence/src
COPY packages/conformance/src packages/conformance/src
COPY reference-app/src reference-app/src
RUN pnpm exec tsc --build reference-app/tsconfig.json

# Production dependencies only, from the lockfile, for the app and the packages it depends on.
FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/idemfence/package.json packages/idemfence/
COPY packages/conformance/package.json packages/conformance/
COPY reference-app/package.json reference-app/
RUN pnpm install --frozen-lockfile --prod --filter idemfence-reference-app...

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/reference-app/node_modules ./reference-app/node_modules
COPY packages/idemfence/package.json packages/idemfence/
COPY --from=build /repo/packages/idemfence/dist packages/idemfence/dist
COPY reference-app/package.json reference-app/
COPY --from=build /repo/reference-app/dist reference-app/dist
USER node
EXPOSE 3000
CMD ["node", "reference-app/dist/server.js"]
