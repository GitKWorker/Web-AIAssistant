# AI 助手

轻量团队消息同步工具。单进程 Node 服务，SSE 实时推送（不支持时自动回落 3 秒轮询），零第三方依赖。

---

## 先看这里：哪些必须配

大部分参数都有默认值，**不配也能跑起来**。真正需要你决定的只有下面这些：

| 你要做的事 | 必须配置 | 漏配的后果 |
|---|---|---|
| 本机 `npm start` 直接跑 | **什么都不用配** | 默认 `http://localhost:3080` |
| Docker 跑起来 | `-p 3080:3080`（端口映射，不是环境变量） | 宿主机访问不到 |
| **用文件上传 / 发文件页** | `R2_ACCOUNT_ID`、`R2_ACCESS_KEY`、`R2_SECRET_KEY`、`R2_BUCKET`、`R2_PUBLIC_BASE` **五个全部填** | 缺任意一个 → `fileUpload` 为 `false`，上传入口**在界面上整体消失**（不报错、不留提示） |
| 允许用户自己注册 | `ALLOW_REGISTER=1` | 默认关闭，登录页只有「登录」无「注册」 |
| **启用永久存储页签（可选）** | `TIGRIS_ACCESS_KEY`、`TIGRIS_SECRET_KEY`、`TIGRIS_BUCKET` | 不配则文件页只有「临时存储」页签，消息功能不受影响 |
| 换端口 | `PORT`（默认 3080） | — |
| 限制单文件大小 | `R2_MAX_SIZE_MB`（默认 100） | — |
| 内存很小的机器 | `NODE_OPTIONS=--max-old-space-size=96`（建议值） | 不配也能跑，配了更稳 |

**最容易踩的一条**：R2 那五个变量是「要么全填、要么全不填」。代码里 `isConfigured()` 要求五个全部非空，少一个（哪怕只是 `R2_PUBLIC_BASE`）整个上传功能就关闭，而界面上不会给你任何错误提示——入口直接不渲染。

---

## 环境变量全表

代码实际读取的全部变量，无遗漏：

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `PORT` | 否 | `3080` | 监听端口 |
| `HOST` | 否 | `0.0.0.0` | 监听地址 |
| `ALLOW_REGISTER` | 否 | 关闭 | `1/true/yes/on` 开启自助注册；账号库为空时首次注册始终放行 |
| `NODE_OPTIONS` | 否 | — | Node 运行时参数，低内存机器建议 `--max-old-space-size=96` |
| `R2_ACCOUNT_ID` | **是（用时）** | — | Cloudflare 32 位账号 ID |
| `R2_ACCESS_KEY` | **是（用时）** | — | R2 API Token 的 Access Key ID |
| `R2_SECRET_KEY` | **是（用时）** | — | R2 API Token 的 Secret（64 位十六进制） |
| `R2_BUCKET` | **是（用时）** | — | 桶名，如 `aia-files` |
| `R2_PUBLIC_BASE` | **是（用时）** | — | 桶的自定义域，如 `https://files.frkang.top`，不带结尾斜杠 |
| `R2_MAX_SIZE_MB` | 否 | `100` | 单文件上限，超出返回 413 |
| `TIGRIS_S3_ENDPOINT` | 否 | `https://fly.storage.tigris.dev` | 永久存储的 S3 兼容端点 |
| `TIGRIS_ACCESS_KEY` | **是（用时）** | — | Tigris Access Key（`tid_` 开头） |
| `TIGRIS_SECRET_KEY` | **是（用时）** | — | Tigris Secret（`tsec_` 开头） |
| `TIGRIS_BUCKET` | **是（用时）** | — | 永久存储桶名，如 `aia-keep` |
| `TIGRIS_MAX_SIZE_MB` | 否 | `100` | 永久存储单文件上限 |

「用时」＝只有你要用文件上传功能才需要；不配则消息功能完全不受影响。

另外两个**只给本地脚本用**、服务进程不读的变量写在「空间占用统计」一节。

---

## 快速开始（本机）

```bash
cd ai-assistant
npm start                  # 默认 http://localhost:3080
PORT=8080 npm start        # 换端口
ALLOW_REGISTER=1 npm start # 临时开回登录页的自助注册
```

局域网访问 `http://<本机IP>:3080`。HTTPS 请自行在反向代理层（Nginx / Caddy）配置，程序本身只监听 HTTP。

首次启动会自动创建 **admin / admin123**，登录后请到「系统设置 → 账号」改掉。其余账号由管理员在「系统设置 → 用户管理」里创建。

本机跑时，根目录 `.env.local` 会被自动读取（该文件同时被 `.gitignore` 和 `.dockerignore` 排除，不会进 git，也不会进镜像）。文件格式就是 `KEY=VALUE` 一行一条，`#` 开头为注释；**已存在的环境变量优先，文件里的值不会覆盖它**。

---

## Docker 部署

镜像基于 `alpine:3.24`，只从官方 node 镜像里拷入 strip 过的 `node` 二进制与 `libstdc++`，**不含 npm / npx / tzdata / curl**，运行阶段不执行任何 `apk`；以 **UID 10001** 非 root 用户运行，数据落在 `/app/data`。

```bash
docker build -t ai-assistant:1.1.0 .
```

### 变量怎么传：三种方式

镜像里**不包含**任何密钥文件（`.env.local` 被 `.dockerignore` 排除）。变量有三种传法，按推荐顺序：

#### 方式 A：`--env-file` 批量传入（推荐）

```bash
cat > /root/ai-assistant.env <<'EOF'
PORT=3080
ALLOW_REGISTER=0
NODE_OPTIONS=--max-old-space-size=96
R2_ACCOUNT_ID=你的32位账号ID
R2_ACCESS_KEY=访问密钥ID
R2_SECRET_KEY=机密访问密钥
R2_BUCKET=aia-files
R2_PUBLIC_BASE=https://files.frkang.top
R2_MAX_SIZE_MB=100
EOF
chmod 600 /root/ai-assistant.env

docker run -d --name ai-assistant --restart unless-stopped \
  -p 3080:3080 \
  --env-file /root/ai-assistant.env \
  -v /share/ai-assistant/data:/app/data \
  --memory=128m --cpus=1.0 \
  --log-opt max-size=5m --log-opt max-file=2 \
  ai-assistant:1.1.0
```

两点必须清楚：

- **`--env-file` 的路径是客户端路径**，也就是你敲 docker 命令那台机器上的路径，不是宿主机的 `/share/...`。如果 docker 命令跑在 QNAP 的 Linux Station 里，写 `/root/ai-assistant.env`；写在 `/share/...` 会找不到文件。
- 文件里有 `#` 注释是安全的（Docker 20.10+ 支持），但**不要加引号、不要写 `export`**。

#### 方式 B：`-e` 逐个传入

```bash
docker run -d --name ai-assistant -p 3080:3080 \
  -e PORT=3080 \
  -e R2_ACCOUNT_ID=... -e R2_ACCESS_KEY=... -e R2_SECRET_KEY=... \
  -e R2_BUCKET=aia-files -e R2_PUBLIC_BASE=https://files.frkang.top \
  ai-assistant:1.1.0
```

能用，但**密钥会留在 shell history 里，并且 `docker inspect` 直接显示明文**。只适合临时调试，不建议长期用。

#### 方式 C：把配置文件挂载进去

服务启动时会读 `/app/.env.local`，所以可以直接把这个文件挂进容器：

```bash
docker run -d --name ai-assistant -p 3080:3080 \
  -v /share/ai-assistant/prod.env:/app/.env.local:ro \
  -v /share/ai-assistant/data:/app/data \
  ai-assistant:1.1.0
```

**这条路可行，但有一个会静默失效的坑，实测过**：

| 文件权限 | 结果 |
|---|---|
| `600 root:root` | **完全不生效，且不报任何错** —— 容器以 UID 10001 运行读不了，回退到全部默认值 |
| `644` 且属主 10001（或 `644` 允许 other 读） | 正常生效 |

所以挂载前必须：

```bash
chown 10001:10001 /share/ai-assistant/prod.env
chmod 644 /share/ai-assistant/prod.env
```

它的**唯一优势是更隐蔽**：`docker inspect` 只看得到挂载路径，看不到变量值。缺点是改完文件要重启容器才生效（只在启动时读一次）。

#### 三种方式对比

| | A `--env-file` | B `-e` | C 挂载文件 |
|---|---|---|---|
| 密钥是否出现在 `docker inspect` | 是（明文） | 是（明文） | **否**（只显示路径） |
| 密钥是否进 shell history | 否 | 是 | 否 |
| 改配置后 | 重建容器 | 重建容器 | 重启容器 |
| 踩坑风险 | 路径搞错 | 变量名打错 | **权限不对会静默失效** |

#### 用 compose

`docker-compose.yml` 已参数化，把变量写进同目录 `.env`，然后 `docker compose up -d`。需要 bind mount 时额外传 `AIA_DATA_DIR=/share/xxx/ai-assistant/data`，不传则回退到命名卷 `ai-assistant-data`。

### 数据目录

`/app/data` 里存 `accounts.json`（账号，scrypt 哈希）和 `messages.ndjson`（消息，追加写）。会话在内存里，重启后需重新登录。

| | 命名卷 | bind mount 到共享文件夹 |
|---|---|---|
| 启动参数 | `-v ai-assistant-data:/app/data` | `-v /share/xxx/ai-assistant/data:/app/data` |
| 备份 | `docker cp ai-assistant:/app/data ./backup` | File Station 里直接复制 |
| 迁移 | 要导出整卷 | 拷目录即可 |
| 权限 | 不用管 | **必须先 `chown -R 10001:10001 <目录>`** |

bind mount 的两个坑：

1. **权限**：容器非 root（UID 10001），目录不 chown 就写不进 `accounts.json`，容器会反复重启。日志里是 EACCES。
2. **空目录不等于空密码**：换目录时如果忘了迁移数据，账号库是空的，登录会变成走「首次注册」流程，历史消息也一并消失。

从命名卷搬到宿主机目录：

```bash
docker run --rm --user 0 \
  -v ai-assistant-data:/from \
  -v /share:/hostshare \
  ai-assistant:1.1.0 sh -c \
  'mkdir -p /hostshare/xxx/ai-assistant/data && cp -a /from/. /hostshare/xxx/ai-assistant/data/ && chown -R 10001:10001 /hostshare/xxx/ai-assistant'
```

### 部署自检

```bash
curl http://<host>:3080/api/config
```

看返回里的三个字段：

| 字段 | 期望 | 不对说明什么 |
|---|---|---|
| `fileUpload` | `true` | `false` ＝ R2 五个变量没传全，或方式 C 的文件权限不对 |
| `maxFileMB` | `100`（或你设的值） | 显示 `100` 但你设了别的值 ＝ 变量没生效 |
| `allowRegister` | `false` | 应为 `false`，除非你确实要开自助注册 |

---

## 功能

- **消息同步**：同一界面发送，所有在线设备实时看到新消息（SSE 推送，秒级；连接不通时自动回落 3 秒轮询，断线重连按游标补齐不丢消息）
- **身份**：登录用户名 + 设备名，例如 `张明 · Windows-PC`；同一账号多设备可同时在线，各占一个在线位
- **在线上限**：20 台设备，满载时新登录提示「当前在线已满」，关页面 / 断线 15 秒内自动释放
- **消息量**：首屏只拉最近 3 条，界面最多保留 50 条（可在设置改为 20 / 100）
- **保留策略**：服务端最多保留 30 天、且最多 10000 条，超出按时间与条数双重清理
- **复制**：每条消息右侧有复制按钮，点击复制整条消息内容
- **系统设置**：改用户名 / 密码（需验证当前密码）、消息显示条数、设备名、清空本地偏好、退出登录
- **用户管理**（仅管理员）：增加、编辑、删除账号，可设管理员 / 普通成员，列表显示角色与在线状态；删除或改密后该用户在线会话立即失效
- **文件直传**：聊天框左侧回形针发送附件（**始终走 R2 临时存储**），侧栏「文件」页生成临时链接与二维码。文件字节由浏览器直传对象存储，**不经本服务转发、不占服务器磁盘与带宽**，服务端只签发一次性上传许可并记录元数据
- **双存储页签（页面顶部）**：「文件」页最顶部是**临时存储**（R2，保留 7 天自动清理）与**永久存储**（Tigris，无生命周期永不清理）两个切换页签，所有用户可见；上传区的去向、空间用量、云端列表都跟随当前页签，一眼可知当天上传的文件落在哪个存储。下方云端列表仍仅管理员可见（预览、下载、复制链接、扫码、移动、删除）
- **多层文件夹（仅管理员）**：云端列表支持任意层级目录（`a/b/c`）、面包屑导航、新建文件夹、把文件移动到其他目录、删除文件夹（非空时二次确认后连带删除）。进入某个目录后上传，文件就落在该目录；聊天附件不参与目录结构，始终在根目录
- **云端文件**：显示已用空间与分类明细（R2 侧 10 GB、Tigris 侧 5 GB 免费额度进度条）；图片、PDF、音视频、纯文本可直接在页面内预览，任意文件都能一键下载（保留原文件名）
- **分享记录不丢**：发文件页生成的链接、二维码常驻，切到其他页面再回来、刷新浏览器都还在；最近 10 条记录保存在浏览器本地（localStorage），过期条目自动标灰并只保留「移除」

---

## 文件直传（Cloudflare R2，可选功能）

不配 R2 时上传入口整体隐藏，消息功能完全不受影响。

### 必配的五个变量

在 `.env.local`（本机）或 `--env-file` 文件（Docker）里写：

```
R2_ACCOUNT_ID=你的32位账号ID
R2_ACCESS_KEY=访问密钥ID
R2_SECRET_KEY=机密访问密钥
R2_BUCKET=aia-files
R2_PUBLIC_BASE=https://files.frkang.top
R2_MAX_SIZE_MB=100          # 可选，默认 100
```

- 前五个**缺一不可**，缺任何一个功能整体关闭
- `R2_PUBLIC_BASE` 填桶绑定的自定义域，**不要带结尾斜杠**
- `R2_SECRET_KEY` 是 64 位十六进制，复制时容易漏尾巴，只显示一次

### 桶必须满足的三个条件

这三条在 Cloudflare 侧配置，少任何一条都会导致上传失败或链接不可用：

1. **绑定自定义域**（桶 → Settings → Public access → Custom Domains）—— 公开读靠它，`r2.dev` 子域只用于调试且限速
2. **CORS 策略**：来源 `*`、方法 `GET/PUT`、请求头 `Content-Type`（缺这项浏览器上传会**静默失败**，服务端日志一个字节都不会有）
3. **对象生命周期规则**：创建 7 天后删除，与代码里 `RETAIN_DAYS = 7` 保持一致

### 工作方式

```
浏览器                    本服务                 Cloudflare R2
  │  POST /api/files/sign   │                        │
  ├────────────────────────>│  只签一张上传许可        │
  │  presigned PUT URL      │                        │
  │<────────────────────────┤                        │
  │  PUT 文件字节（几十 MB）                          │
  ├─────────────────────────────────────────────────>│
  │  POST /api/messages {file}                       │
  ├────────────────────────>│  只存元数据，不碰文件    │
```

- 对象键：R2 侧 `c/<32位随机hex>/<文件名>`（聊天附件）或 `s/…`（独立分享）；Tigris 侧 `k/…`（永久保存）。文件名进 URL 使浏览器下载时自动使用真实文件名
- **安全**：`text/html`、`image/svg+xml` 等可执行类型一律降级为 `application/octet-stream`，避免在文件域下执行脚本；服务端校验回传的 URL 必须落在 `R2_PUBLIC_BASE` 上，防止伪造外链
- 上传用 XHR 而非 fetch —— 只有 XHR 能读取上传进度
- 文件默认保留 7 天，过期后消息里的卡片变灰显示「已过期清理」
- 上传中的 XHR 按场景（`chat` / `share`）分开登记，切换页面或取消一处上传不会误伤另一处
- 发文件页的结果卡片由 `state.lastShare` 驱动，进入页面只做恢复、不做清空；只有点「再传一个」才清当前结果，历史记录不动

### 文件夹（多层目录）

对象存储（R2 / Tigris 都是 S3 兼容）**没有真目录**，文件夹只是对象键里的一段路径。本项目把目录放在存储前缀之后、对象 id 之前：

```
k/工作/2026/<32位hex>/年终报告.pdf     ← 永久存储里的「工作/2026」
s/<32位hex>/散装文件.zip                ← 根目录（老对象与聊天附件同形，天然兼容）
```

- **目录列表**：服务端把整桶对象拉平后按当前路径切视图，返回 `folders`（一级子目录，含直属文件数与体积）+ `objects`（当前目录文件）+ `crumbs`（面包屑）；空目录靠 0 字节的 `.folder` 占位对象保留，不会因为没文件而消失
- **新建**：`POST /api/files/folder` 写入占位对象；输入框支持 `工作/2026` 一次建多层
- **移动**：`POST /api/files/move` 用 S3 `CopyObject`（`x-amz-copy-source` 参与签名）在服务端复制到新前缀再删旧对象，**字节不经过本机**，大文件也是秒完成；移动后原链接失效
- **删除**：`DELETE /api/files/folder` 列出该前缀下全部对象逐个删除（并发 4），前端在非空时会提示"含 N 个文件，删除后不可恢复"
- **上传去向**：跟随当前所在目录，页面上的上传区会显示"上传到：临时存储 / 工作/2026"；普通成员没有目录列表权限，一律传根目录
- **目录名限制**：单段最多 40 字、最多 6 层、总长 200，禁止 `.` / `..` 与控制字符

### 云端文件与空间用量（双存储页签）

「文件」页**顶部**是存储切换页签（所有用户可见，控制上传去向），下方的桶内真实对象列表**仅管理员可见**（服务端对所有相关接口做角色校验，普通成员不仅界面隐藏，连请求都不会发出）：

| 页签 | 后端 | 生命周期 | 上传去向 |
|---|---|---|---|
| 临时存储 | Cloudflare R2（桶 `R2_BUCKET`） | 7 天自动清理 | 上传区默认去向 |
| 永久存储 | Tigris（桶 `TIGRIS_BUCKET`，S3 兼容端点 `TIGRIS_S3_ENDPOINT`） | 无，永不清理 | 页签切换后上传区自动跟随 |

数据来自服务端 `GET /api/files?store=tmp\|keep`（S3 `ListObjectsV2`，纯 `node:crypto` 签名，零依赖）：

- 顶部卡片显示已用空间与分类计数；R2 侧 10 GB / Tigris 侧 5 GB 免费额度进度条（超 80% 转红）
- 列表按创建时间倒序，最多渲染最近 100 条；每行给出查看、下载、复制链接、扫码、删除
- **查看**：图片走页面内预览层，PDF / 视频 / 音频 / 纯文本用 `iframe` 或原生播放器；类型按扩展名判断，其余只提供下载。R2 用公开域直链，Tigris 无公开域改发 1 小时有效的 inline 签名链接
- **下载**：前端先向 `GET /api/files/download?key=…` 换取 5 分钟有效的签名链接，再由浏览器直连对象存储取字节——**文件依旧不经过本服务**。签名里带 `response-content-disposition`，图片和 PDF 也会直接另存为原文件名，而不是在新标签里打开
- **扫码**：每行右侧二维码图标生成 `GET /api/files/scan?key=…` 的二维码。这条入口免登录（手机扫码没有会话），访问时服务端现签 5 分钟下载链接再 302 跳转，因此**二维码本身长期有效**，且强制走 `attachment`，扫码即下载原名文件。保密性来自 key 里的 32 位随机 hex，与公开域直链同等强度；key 首段（`c/`、`s/`、`k/`）决定路由到哪个桶
- **删除**：每行右侧垃圾桶按钮，二次确认后调 `DELETE /api/files?key=…`，服务端用 SigV4 DELETE 真删对象，删完缓存立即失效、列表与用量同步刷新；删除不可恢复
- 永久存储的分享链接也指向扫码入口（Tigris 无公开域，服务端会根据请求 Host 生成），同样长期有效
- 列表与用量有 15 秒服务端缓存（两个存储各自独立）：进入页面缓存优先，只有超过 60 秒或手动点「刷新」/刚上传完才强刷；加载期间列表区显示「加载中…」，切换页签时在途的慢响应会被作废，不会把 A 存储的数据渲染到 B 页签下；签发新上传许可时缓存立即失效

### 自检

```bash
node scripts/r2-smoke.js     # 签名 / 上传 / 公开读取 三项连通性
node scripts/upload-flow.js  # 需先 npm start：登录 → 签名 → 上传 → 发消息 → 拉回核对
npm run test:share           # 需先 npm i -D jsdom：发文件页、双存储页签、文件夹导航/新建/移动/删除、权限/扫码的 DOM 级回归测试（85 项）
```

---

## 空间占用统计（本地脚本）

遍历桶内全部对象（S3 `ListObjectsV2` 分页），统计对象数、总占用、免费额度占比，并按 `c/`（聊天附件）、`s/`（独立分享）分类：

```bash
node scripts/r2-usage.js          # 控制台报告
node scripts/r2-usage.js --preview # 预览将推送的文本，不发送
node scripts/r2-usage.js --json   # JSON 输出
node scripts/r2-usage.js --push   # 同时推送到企业微信群机器人
```

以下两个变量**只给这个脚本用**，服务进程不读：

| 变量 | 说明 |
|---|---|
| `WECOM_WEBHOOK_KEY` | 群机器人 key（群设置 → 群机器人 → 添加机器人） |
| `WECOM_WEBHOOK_URL` | 完整 webhook 地址，优先级更高；用于换非企微的转发服务 |

两者都没配时，脚本会回落到 `~/.workbuddy/skills/workbuddy-auto-checkin/config.json` 里已配置的群机器人。消息为纯文本（企微 text 类型单条上限 2048 字节）。

注意：`GET /{bucket}?lifecycle` 需要 Admin 级令牌，仅有 Object Read & Write 的令牌会返回 403，脚本此时报「无法验证」而非「未配置」。

---

## 账号

- 角色分两级：**管理员**（可管理所有账号）与**普通成员**（只能改自己的用户名 / 密码）
- 第一个初始账号 `admin` 是管理员；老数据升级时，若没有任何管理员，会自动把 `admin`（或第一个账号）提升为管理员
- **自助注册默认关闭**：账号一律由管理员在「系统设置 → 用户管理」里创建
- 保护措施：不能删除当前登录的账号；至少保留一个管理员；账号总数上限 50
- 密码使用 scrypt + 随机盐哈希存储，不保存明文
- 修改用户名、密码或角色后，该账号所有会话失效，需要重新登录

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/register` | 自助注册（**默认关闭**，返回 403 `REGISTER_DISABLED`；账号库为空时放行） |
| POST | `/api/login` | 登录，返回会话 ID |
| POST | `/api/logout` | 退出（支持 `?sid=` 供页面关闭时上报） |
| POST | `/api/heartbeat` | 心跳，5 秒一次 |
| GET | `/api/me` | 校验会话、取当前身份 |
| GET | `/api/messages?limit=3` | 首屏最近 N 条 |
| GET | `/api/messages?afterId=N&limit=50` | 增量拉取（SSE 不可用时的兜底） |
| GET | `/api/stream?sid=…&afterId=N` | **SSE 实时通道**，事件：`hello` / `backlog` / `message` / `online` |
| POST | `/api/messages` | 发送消息，可带 `file` 字段（附件消息） |
| POST | `/api/files/sign` | **申请上传许可**：`{name, size, mime, scene, folder}`，scene 为 `chat`/`share`（R2）或 `keep`（Tigris），`folder` 为目标目录（可空）→ 返回 `uploadUrl`（presigned PUT）/ `publicUrl` / `key` / `store` / `expireAt`（keep 为 0 表示永久） |
| GET | `/api/files?store=tmp\|keep&folder=工作/2026` | **目录视图 + 空间用量（仅管理员）**：`{store, folder, crumbs, folders, objects, usage, truncated, cached}`；`?refresh=1` 跳过 15 秒缓存 |
| POST | `/api/files/folder` | **新建文件夹（仅管理员）**：`{store, path}`，写入 0 字节 `.folder` 占位对象 |
| DELETE | `/api/files/folder?store=&path=` | **删除文件夹（仅管理员）**：按前缀批量删除对象与占位文件，返回 `{deleted}` |
| POST | `/api/files/move` | **移动文件（仅管理员）**：`{key, folder}`，服务端 `CopyObject` + `Delete`，返回新 `key` |
| GET | `/api/files/download?key=…` | **签发下载链接（仅管理员）**：返回 5 分钟有效的 presigned GET（带 `attachment` 头，原文件名） |
| DELETE | `/api/files?key=…` | **删除单个对象（仅管理员）**：SigV4 `DeleteObject`，幂等，删完列表缓存立即失效 |
| GET | `/api/files/scan?key=…` | **扫码下载入口（免登录）**：现签 5 分钟链接后 `302` 跳转，二维码可长期复用 |
| POST | `/api/account` | 修改自己的用户名 / 密码 |
| GET | `/api/users` | **用户列表（仅管理员）**，含角色与在线数 |
| POST | `/api/users` | **新增用户（仅管理员）**：`{username, password, role}` |
| PATCH | `/api/users/:name` | **编辑用户（仅管理员）**：`{username?, password?, role?}` |
| DELETE | `/api/users/:name` | **删除用户（仅管理员）** |
| GET | `/api/state` | 在线成员与游标 |
| GET | `/api/config` | 配置（含 `allowRegister` / `fileUpload` / `keepUpload` / `maxFileMB`） |
| GET | `/api/health` | 健康检查 |

除登录、健康检查外，均需请求头 `X-Session-Id`；SSE 因浏览器 `EventSource` 无法带自定义头，改用查询参数 `?sid=`。

响应按 `Accept-Encoding` 自动 gzip（JSON ≥512B、静态文件 ≥1KB），静态文件带 `ETag` 支持 304。

---

## 数据

- `data/messages.ndjson`：消息，**一行一条 NDJSON 追加写**（不再整文件重写），崩溃残留的半行在启动时自动跳过；累计冗余超过 `max(200, 条数×25%)` 时原子重写压缩一次（tmp + rename）
- `data/accounts.json`：账号（scrypt 哈希 + 角色）
- `data/messages.json`：旧版全量 JSON，存在时启动自动迁移为 NDJSON 并重命名为 `.bak`

删掉 `data/` 目录即可重置全部数据（重启后会重新生成 admin/admin123）。

---

## 安全与限制

- 消息纯文本渲染（`textContent`），不解析 HTML，链接只识别 `http(s)://`
- 单条最多 2000 字，同一设备 10 秒内最多 10 条
- 客户端 `clientMsgId` 去重，重试不会产生重复消息
- 断网重连按 `afterId` 补齐；游标失效（历史被清理）时自动替换为最新快照
