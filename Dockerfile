# ---- 构建阶段 ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

# ---- 运行阶段 ----
FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_FILE=/data/pool-db.json
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /data && chown -R app:app /data
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/dist-server ./dist-server
USER app
EXPOSE 4000
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "dist-server/server/index.js"]
