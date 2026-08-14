FROM node:24.19.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/hive-gateway/package.json packages/hive-gateway/package.json
COPY workers/collectible-issuer/package.json workers/collectible-issuer/package.json
COPY workers/haf-projector/package.json workers/haf-projector/package.json
COPY workers/match-publisher/package.json workers/match-publisher/package.json
RUN npm ci --ignore-scripts

COPY apps/api apps/api
COPY packages/database packages/database
COPY packages/hive-gateway packages/hive-gateway
RUN npm run build --workspace @hive-chameleon/api \
    && rm -rf node_modules \
    && npm ci --omit=dev --ignore-scripts --workspaces --include-workspace-root

FROM node:24.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/database/package.json ./packages/database/package.json
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/hive-gateway/package.json ./packages/hive-gateway/package.json
COPY --from=build /app/packages/hive-gateway/dist ./packages/hive-gateway/dist

USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
