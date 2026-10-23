# Official Node.js release 24.18.0 includes npm 11.16.0. The index is pinned for
# reproducible amd64/arm64 builds; all stages use the same Node/OS image.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base
WORKDIR /app
RUN test "$(node --version)" = "v24.18.0" && test "$(npm --version)" = "11.16.0"

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
COPY migrations ./migrations
COPY examples ./examples
COPY scripts/clean.mjs scripts/copy-migrations.mjs scripts/copy-route-examples.mjs ./scripts/
RUN npm run build

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
ENTRYPOINT []
CMD ["node", "/app/dist/server/index.js"]
