# The bridge runs at the company (ADR 0035, ADR 0077). Build from the repo root:
#   docker build -f packages/bridge/Dockerfile -t bipe-business-bridge .
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/bridge/package.json packages/bridge/
COPY packages/inbox/package.json packages/inbox/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm --filter ./packages/bridge build && pnpm --filter ./packages/inbox build
RUN pnpm --filter ./packages/bridge deploy --prod --legacy /out

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production INBOX_DIR=/app/inbox BRIDGE_DB=/data/bridge.sqlite PORT=8080
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./
COPY --from=build /app/packages/bridge/dist ./dist
COPY --from=build /app/packages/inbox/dist ./inbox
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "dist/src/server.js"]
