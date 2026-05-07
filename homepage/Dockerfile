FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY src ./src
COPY public ./public
COPY index.html ./
COPY vite.config.ts ./
COPY tsconfig.json ./
COPY postcss.config.js ./
COPY tailwind.config.js ./

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

RUN npm run build

# Production stage
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
