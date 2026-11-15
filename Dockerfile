# syntax=docker/dockerfile:1
#
# 极简运行镜像：不装 npm / npx / tzdata / curl，运行时阶段连 apk 都不执行。
# 构建阶段只从官方 node 镜像里"抠"出 node 二进制并 strip，运行阶段用现成的 alpine 底座。
#
ARG NODE_IMAGE=node:22-alpine
ARG BASE_IMAGE=alpine:3.24

# ---------- 阶段 1：取 node 二进制 ----------
FROM ${NODE_IMAGE} AS nodebin

RUN apk add --no-cache binutils >/dev/null 2>&1 || echo '[build] binutils 不可用，跳过 strip'
RUN cp /usr/local/bin/node /tmp/node \
 && (strip --strip-all /tmp/node 2>/dev/null || echo '[build] strip 跳过') \
 && printf '[build] node 二进制大小：' && du -h /tmp/node | cut -f1 \
 && printf '[build] 动态库依赖：\n' && ldd /tmp/node || true

# ---------- 阶段 2：运行时 ----------
FROM ${BASE_IMAGE}

LABEL org.opencontainers.image.title="AI 助手" \
      org.opencontainers.image.description="轻量团队消息同步工具（SSE 推送 + NDJSON 追加存储，零第三方依赖）" \
      org.opencontainers.image.licenses="MIT"

# node 的 C++ 运行库从构建阶段带过来，运行时不需要 apk
COPY --from=nodebin /tmp/node /usr/local/bin/node
COPY --from=nodebin /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=nodebin /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1

RUN addgroup -g 10001 app \
 && adduser -D -u 10001 -G app -h /app -s /sbin/nologin app

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY --chown=10001:10001 package.json server.js ./
COPY --chown=10001:10001 lib ./lib
COPY --chown=10001:10001 public ./public

RUN mkdir -p /app/data && chown 10001:10001 /app/data \
 && node -v && echo '[build] node 可在运行镜像内启动'

USER 10001:10001
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})"

CMD ["node", "server.js"]
