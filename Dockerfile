# One image per server: docker build --build-arg SERVER=<name> -t mcp-depot-<name> .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY schemas ./schemas
COPY packages ./packages
COPY servers ./servers
RUN npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev

FROM node:22-slim
ARG SERVER
RUN test -n "$SERVER" || (echo "build with --build-arg SERVER=<name>" && exit 1)
ENV NODE_ENV=production SERVER=${SERVER} PORT=8080
WORKDIR /app
# Optional OS packages a server needs at runtime: one name per line in servers/<name>/apt-packages.txt
# (# comments allowed). Servers without the file get exactly the base image.
RUN --mount=type=bind,source=servers,target=/tmp/servers \
    list="/tmp/servers/${SERVER}/apt-packages.txt"; \
    if [ -f "$list" ]; then \
      pkgs="$(sed -e 's/#.*//' "$list" | tr -s ' \t\r\n' ' ')"; \
      case "$pkgs" in *[!a-z0-9.+\ -]*) echo "bad package name in $list" >&2; exit 1;; esac; \
      if [ -n "${pkgs# }" ]; then \
        apt-get update && apt-get install -y --no-install-recommends $pkgs && rm -rf /var/lib/apt/lists/*; \
      fi; \
    fi
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/schemas ./schemas
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist/src ./packages/core/dist/src
COPY --from=build /app/servers/${SERVER}/package.json /app/servers/${SERVER}/manifest.yaml /app/servers/${SERVER}/roles.yaml ./servers/${SERVER}/
COPY --from=build /app/servers/${SERVER}/dist/src ./servers/${SERVER}/dist/src
USER node
# Documentation only: deployments publish no host ports (ADR 0001).
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["sh", "-c", "exec node servers/${SERVER}/dist/src/index.js"]
