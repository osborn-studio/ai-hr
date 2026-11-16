# ============================================================================
# Dockerfile · 单容器运行（数据库也在这个容器里，见下方说明）
# ----------------------------------------------------------------------------
# ⚠️ 这份文件**没有在本机验证过**（本机无 Docker）。写它的目的是交接时能用，
#    所以每一项都写清楚为什么，而不是"能跑就行"。
#
# 构建上下文是 code/ 目录：
#     cd code && docker compose up --build
#     # 或 docker build -t ai-hr:local code/ && docker run -p 8787:8787 -v aihr:/data ai-hr:local
#
# 为什么数据库和 app 在同一个容器：
#   PGlite 是 "PostgreSQL 编译成 WASM"，跑在 Node 进程里。它没有独立进程，
#   所以没有「app 容器 + db 容器」这种拆法 —— 拆了就连不上。
#   代价：**只能单实例**。要横向扩展必须换成真 PostgreSQL + 连接池，
#   那时代码里要改的只有 db.mjs（设 DATABASE_URL 即可，契约见 test/db-contract）。
#
# 数据在 /data：不挂卷就是"重启丢库"，比丢会话严重得多。
# ============================================================================
FROM node:22-slim

WORKDIR /app

# 先装依赖（利用层缓存）。pg 在 optionalDependencies 里：不用真库时不装也不影响。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --fund=false

COPY app ./app
COPY db  ./db

# 数据目录，并把它交给非 root 用户
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    PGLITE_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8787

# ★ 探针用 /livez（免认证），不是 /api/health（要 token，未认证是 401）。
#   用需要凭据的端点做探针 = 永远 unhealthy = 探针很快被删掉 = 服务挂了没人知道。
#   这里刻意用 node 自己发请求：node:22-slim 没有 curl，也不该为一个探针装一个。
#   /livez 只证进程存活；/readyz 才查库 —— 库挂了不该重启进程，只该挪走流量。
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app/server.mjs"]
