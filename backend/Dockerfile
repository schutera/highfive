# backend/Dockerfile (production)
#
# Build context is the repo root (see docker-compose.prod.yml). The
# image installs the whole npm workspace (contracts + backend + homepage)
# so the `@highfive/contracts` workspace symlink resolves at build and
# runtime. The image does NOT bind-mount source - the dist/ is baked in.
FROM node:22-alpine AS builder

WORKDIR /app

# Copy lockfile + every workspace package.json so `npm ci` can resolve
# the workspace graph without needing the rest of the source. The
# `.npmrc` carries `engine-strict=true` (see ADR-009) so a future
# base-image swap to a sub-22.12 Node would hard-fail here instead of
# silently warning.
COPY package.json package-lock.json .npmrc ./
COPY contracts/package.json ./contracts/package.json
COPY backend/package.json ./backend/package.json
COPY homepage/package.json ./homepage/package.json

RUN npm ci

# Contracts source - backend imports its types at compile time.
COPY contracts ./contracts

# Backend source.
COPY backend ./backend

WORKDIR /app/backend
RUN npm run build

# Compile contracts to CommonJS JS for the runtime stage.
# contracts/package.json "main":"src/index.ts" is intentional for dev (tsx
# loads it transparently), but plain `node` in prod cannot parse TypeScript.
# Compiled output is placed at /tmp/contracts-js/index.js and copied into
# the runtime stage under the same filename the "main" field expects.
WORKDIR /app
RUN node_modules/.bin/tsc \
    --module commonjs \
    --moduleResolution node \
    --target ES2020 \
    --declaration false \
    --rootDir contracts/src \
    --outDir /tmp/contracts-js \
    contracts/src/index.ts

# ---- Runtime stage ----
FROM node:22-alpine

WORKDIR /app

# Re-install with --omit=dev for a slim runtime image. Workspace
# package.jsons + .npmrc must be present so the contracts symlink
# resolves and `engine-strict=true` (ADR-009) is respected.
COPY package.json package-lock.json .npmrc ./
COPY contracts/package.json ./contracts/package.json
COPY backend/package.json ./backend/package.json
COPY homepage/package.json ./homepage/package.json

RUN npm ci --omit=dev --ignore-scripts

# contracts/package.json intentionally points "main" at "src/index.ts" so
# that tsx (dev) and tsc (compile-time) both find TypeScript source.  Plain
# `node` cannot parse TypeScript, so we compile contracts to CJS JS in the
# builder stage and copy the output here under the same filename the "main"
# field expects.  Node loads files by path regardless of extension, so the
# .ts filename causes no issue at runtime.
RUN mkdir -p contracts/src
COPY --from=builder /tmp/contracts-js/index.js ./contracts/src/index.ts

COPY --from=builder /app/backend/dist ./backend/dist

WORKDIR /app/backend

ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "dist/server.js"]
