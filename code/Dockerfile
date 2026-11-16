# React is built once; runtime is one Node process. Configure an external
# PostgreSQL database or domain Broker. No database/credentials/seed in image.
FROM node:22-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
RUN npm ci --no-audit --fund=false
COPY frontend ./frontend
COPY vite.config.js ./
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
RUN npm ci --omit=dev --workspaces=false --no-audit --fund=false
COPY --chown=node:node app ./app
COPY --chown=node:node db ./db
COPY --chown=node:node tools ./tools
COPY --from=frontend --chown=node:node /app/dist ./dist
USER node
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 TYHR_DATA_MODE=postgres
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "app/cloud-server.mjs"]
