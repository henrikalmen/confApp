# Build context is the repository root – this is an npm workspace, so the root manifest and
# lockfile are part of the API's build inputs.
#
# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:24-alpine AS build
WORKDIR /app

# Manifests first so the dependency layer is reused whenever only source changed.
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
COPY db/package.json db/package.json
RUN npm ci --workspace @confapp/api --include-workspace-root

COPY tsconfig.base.json ./
COPY api/tsconfig.json api/tsconfig.json
COPY api/src api/src
RUN npm run build --workspace @confapp/api

# ---------- runtime ----------
# A separate stage so build dependencies (TypeScript and friends) never reach the shipped
# image – it carries production dependencies and compiled JavaScript only.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
COPY db/package.json db/package.json
RUN npm ci --omit=dev --workspace @confapp/api --include-workspace-root \
  && npm cache clean --force

COPY --from=build /app/api/dist api/dist

# Nothing environment-specific is baked in: the listen port and the database connection are
# read from the environment at startup, so this same image runs in development and against
# any other target without a rebuild.
ENV PORT=8080
EXPOSE 8080

USER node

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so the process is PID 1 and receives SIGTERM directly and can drain.
CMD ["node", "api/dist/index.js"]
