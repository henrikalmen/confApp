# Build context is the repository root – this is an npm workspace, so the root manifest and
# lockfile are part of the SPA's build inputs.
#
# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
COPY db/package.json db/package.json
RUN npm ci --workspace @confapp/web --include-workspace-root

COPY tsconfig.base.json ./
COPY web web
RUN npm run build --workspace @confapp/web

# ---------- runtime ----------
# Static assets only – Node and the whole build toolchain stay in the stage above.
FROM nginx:alpine AS runtime

COPY --from=build /app/web/dist /usr/share/nginx/html
COPY web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY web/docker-entrypoint.d/05-resolvers.envsh /docker-entrypoint.d/05-resolvers.envsh
COPY web/docker-entrypoint.d/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh

# The build context may come from a filesystem without an executable bit (Windows), so the
# mode is set here rather than relied upon. The .envsh file is sourced, not executed.
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

# Both are read at container start, never at build time: API_BASE_URL is what the browser
# calls, API_UPSTREAM is where this container proxies /api/ to.
ENV API_BASE_URL=/api
ENV API_UPSTREAM=http://api:8080

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
