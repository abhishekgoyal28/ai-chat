# One image, three services. Pick the service with the command:
#   chat-app     node dist/chat-app/main.js      (default)
#   chat-socket  node dist/chat-socket/main.js
#   chat-expert  node dist/chat-expert/main.js
#   migrations   node dist/shared/database/migrate.js
#   smoke test   node dist/tools/smoke-test.js

# --- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY sdk/js/package.json sdk/js/
COPY dashboard/package.json dashboard/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w sdk/js \
 && npm run build -w server \
 && npm run build -w dashboard

# --- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY sdk/js/package.json sdk/js/
COPY dashboard/package.json dashboard/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/dashboard/dist server/public/dashboard
WORKDIR /app/server
USER node
EXPOSE 3000 3001 3002
CMD ["node", "dist/chat-app/main.js"]
