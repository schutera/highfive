# homepage/Dockerfile (production)
#
# Build context is the repo root (see docker-compose.prod.yml). Same
# workspace setup as backend/Dockerfile - see that file for rationale.
FROM node:22-alpine AS builder

WORKDIR /app

# `.npmrc` carries `engine-strict=true` (see ADR-009) so a future
# base-image swap to a sub-22.12 Node would hard-fail here.
COPY package.json package-lock.json .npmrc ./
COPY contracts/package.json ./contracts/package.json
COPY backend/package.json ./backend/package.json
COPY homepage/package.json ./homepage/package.json

RUN npm ci

COPY contracts ./contracts
COPY homepage ./homepage

# The homepage bundle carries NO API secret (issue #142 / ADR-019): reads are
# public and admin actions ride a server-side session cookie. Only the API base
# URL is baked in. (VITE_API_KEY was removed here — a single-page app cannot hold
# a secret, so anything inlined is public.)
ARG VITE_API_URL=https://api.highfive.schutera.com
ENV VITE_API_URL=$VITE_API_URL

# Build-time feature flags (ADR-022). Default empty = OFF, so a plain prod
# build ships the dashboard latest-captures gallery (#154) disabled. Pass
# --build-arg VITE_ENABLE_DASHBOARD_IMAGES=true to enable it.
ARG VITE_ENABLE_DASHBOARD_IMAGES=
ENV VITE_ENABLE_DASHBOARD_IMAGES=$VITE_ENABLE_DASHBOARD_IMAGES

WORKDIR /app/homepage
RUN npm run build

# ---- Runtime stage: nginx serving the SPA ----
FROM nginx:alpine

COPY homepage/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/homepage/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
