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

ARG VITE_API_URL=https://api.highfive.schutera.com
# No default: docker-compose.prod.yml passes this via build-args with a
# fail-fast ${VITE_API_KEY:?...} so a missing secret aborts before build.
# A standalone `docker build` without --build-arg produces an image with
# an empty key and the running app rejects every request - acceptable
# failure mode, strictly better than baking a broken sentinel into the
# image.
ARG VITE_API_KEY
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_API_KEY=$VITE_API_KEY

WORKDIR /app/homepage
RUN npm run build

# ---- Runtime stage: nginx serving the SPA ----
FROM nginx:alpine

COPY homepage/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/homepage/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
