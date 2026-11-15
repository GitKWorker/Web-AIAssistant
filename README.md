# AI 助手

轻量团队消息同步工具。单进程 Node 服务，SSE 实时推送（不支持时自动回落 3 秒轮询），零第三方依赖。

## 启动

```bash
cd ai-assistant
npm start          # 默认 http://localhost:3000
PORT=8080 npm start # 换端口
```

局域网访问：`http://<本机IP>:3000`。HTTPS 请自行在反向代理层（Nginx / Caddy）配置，程序本身只监听 HTTP。

首次启动会自动创建账号 **admin / admin123**，登录后请到「系统设置 → 账号」改掉。

### Docker 部署（极简 Alpine 镜像）

```bash
docker build -t ai-assistant:1.0.0 .
docker compose up -d            # 或：docker run -d --name ai-assistant -p 3000:3000 -v ai-assistant-data:/app/data ai-assistant:1.0.0
```

镜像基于 `alpine:3.24`，只从官方 node 镜像中拷入 strip 过的 `node` 二进制与 `libstdc++`，**不含 npm / npx / tzdata / curl**，运行阶段不执行任何 `apk`；以 UID 10001 非 root 运行，数据落在命名卷 `ai-assistant-data`。

## 功能

- **消息同步**：同一界面发送，所有在线设备实时看到新消息（SSE 推送，秒级；连接不通时自动回落 3 秒轮询，断线重连按游标补齐不丢消息）
- **身份**：登录用户名 + 设备名，例如 `张明 · Windows-PC`；同一账号多设备可同时在线，各占一个在线位
- **在线上限**：20 台设备，满载时新登录提示「当前在线已满」，关页面 / 断线 15 秒内自动释放
- **消息量**：首屏只拉最近 3 条，界面最多保留 50 条（可在设置改为 20 / 100）
- **保留策略**：服务端最多保留 30 天、且最多 10000 条，超出按时间与条数双重清理
- **复制**：每条消息右侧有复制按钮，点击复制整条消息内容
- **系统设置**：改用户名 / 密码（需验证当前密码）、消息显示条数、设备名、清空本地偏好、退出登录

## 账号

- 登录页可「创建账号」自助注册（2-16 位用户名，6-32 位密码）
- 密码使用 scrypt + 随机盐哈希存储，不保存明文
- 修改用户名或密码后，该账号所有会话失效，需要重新登录

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/register` | 注册账号 |
| POST | `/api/login` | 登录，返回会话 ID |
| POST | `/api/logout` | 退出（支持 `?sid=` 供页面关闭时上报） |
| POST | `/api/heartbeat` | 心跳，5 秒一次 |
| GET | `/api/me` | 校验会话、取当前身份 |
| GET | `/api/messages?limit=3` | 首屏最近 N 条 |
| GET | `/api/messages?afterId=N&limit=50` | 增量拉取（SSE 不可用时的兜底） |
| GET | `/api/stream?sid=…&afterId=N` | **SSE 实时通道**，事件：`hello` / `backlog` / `message` / `online` |
| POST | `/api/messages` | 发送消息 |
| POST | `/api/account` | 修改用户名 / 密码 |
| GET | `/api/state` | 在线成员与游标 |
| GET | `/api/config` `GET /api/health` | 配置 / 健康检查 |

除登录、注册、健康检查外，均需请求头 `X-Session-Id`；SSE 因浏览器 `EventSource` 无法带自定义头，改用查询参数 `?sid=`。

响应按 `Accept-Encoding` 自动 gzip（JSON ≥512B、静态文件 ≥1KB），静态文件带 `ETag` 支持 304。

## 数据

- `data/messages.ndjson`：消息，**一行一条 NDJSON 追加写**（不再整文件重写），崩溃残留的半行在启动时自动跳过；累计冗余超过 `max(200, 条数×25%)` 时原子重写压缩一次（tmp + rename）
- `data/accounts.json`：账号（scrypt 哈希）
- `data/messages.json`：旧版全量 JSON，存在时启动自动迁移为 NDJSON 并重命名为 `.bak`

删掉 `data/` 目录即可重置全部数据（重启后会重新生成 admin/admin123）。

## 安全与限制

- 消息纯文本渲染（`textContent`），不解析 HTML，链接只识别 `http(s)://`
- 单条最多 2000 字，同一设备 10 秒内最多 10 条
- 客户端 `clientMsgId` 去重，重试不会产生重复消息
- 断网重连按 `afterId` 补齐；游标失效（历史被清理）时自动替换为最新快照
