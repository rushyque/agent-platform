# agent-platform 镜像（多阶段：编译 TS → 跑编译产物）
# 构建：docker build -t agent-platform .
# 运行：docker run -p 9876:9876 --env-file .env agent-platform

# ── 1. 编译阶段 ───────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build           # tsc → dist/

# ── 2. 运行阶段（只装生产依赖，镜像更小）─────────────────
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

EXPOSE 9876
CMD ["node", "dist/server.js"]
