# backend/Dockerfile (production)
#
# Build context is the repo root (see docker-compose.prod.yml). The
# image installs the whole npm workspace (contracts + backend + homepage)
# so the `@highfive/contracts` workspace symlink resolves at build and
# runtime. The image does NOT bind-mount source - the dist/ is baked in.
FROM node:20-alpine AS builder

WORKDIR /app

# Copy lockfile + every workspace package.json so `npm ci` can resolve
# the workspace graph without needing the rest of the source.
COPY package.json package-lock.json ./
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

# ---- Runtime stage ----
FROM node:20-alpine

WORKDIR /app

# Re-install with --omit=dev for a slim runtime image. Workspace
# package.jsons must be present so the contracts symlink resolves.
COPY package.json package-lock.json ./
COPY contracts/package.json ./contracts/package.json
COPY backend/package.json ./backend/package.json
COPY homepage/package.json ./homepage/package.json

RUN npm ci --omit=dev

COPY --from=builder /app/contracts ./contracts
COPY --from=builder /app/backend/dist ./backend/dist

WORKDIR /app/backend

ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "dist/server.js"]
