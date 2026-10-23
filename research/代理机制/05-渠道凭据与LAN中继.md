# 05 渠道、凭据与 LAN 中继

分析对象：`/home/fish/projects_mine/dsh-our-free-model`（dsh 插件，只读勘察）。
勘察口径：`src/` 为插件自身实现；渠道实现本体是 vendored 包 `vendor/channel-pack/pack.js`（61708 行，由 `scripts/build-channel-pack.mjs` 打包，`index.js:1025` 动态 import），其可读源码形态是 `packages/standalone/channels/business.mjs`（61698 行，esbuild 产物）。本文对 business.mjs 只做 `grep -n` 抽符号 + 3 段抽样（`38319-38370`、`41560-41650`、`49026-49090` 与 `55890-55920`），未整读。

## 1. 渠道清单与契约

### 1.1 九个渠道在代码中的表示

渠道 = 一个 product 常量（id / displayName / base URL / 默认凭据 ref / 兜底模型表），加上一个 `*Auth` 服务和一个 `LlmAdapter`。id 即注册进 `llm.registerAdapter` 的 provider key（`packages/standalone/channels/worker.mjs:38-43`），也是模型 id 的前缀（`worker.mjs:81` `model.startsWith(\`${provider}/\`)`）。

| 渠道 | product 常量（business.mjs） | id | 默认凭据 ref | 备注 |
|---|---|---|---|---|
| LobsterAI | `:29631` | `lobsterai` | `LOBSTERAI_ACCESS_TOKEN` | 端点常量 `:29360-29367`（exchange/refresh/models/chat/callback）；昵称是手机号，归一化到末 2 位 `:29386-29389` |
| Qoder | `:32540` | `qoder` | `QODER_ACCESS_TOKEN`（`:32549`） | authBase/openApiBase/inferBase/encryptedInferBase 四套域名 `:32542-32547`；带 `qoder-auth-wasm.wasm`（298KB，`vendor/channel-pack/qoder-auth-wasm.wasm`） |
| Qoder CN | `:32693` | `qodercn` | — | 独立 product，与 qoder 分表 |
| TRAE | `:34039` | `trae` | — | 签到设备轮换代次 `traeCheckinDeviceGeneration`（`:29085-29105`） |
| Cline | `:36015` | `cline` | — | 限流倒计时短于真实等待 `:29018-29020` |
| Loomy（讯飞） | `:37079` | `loomy` | `LOOMY_ACCESS_TOKEN`（`:37087`） | 常量里带 `accessKeyId/accessKeySecret/appId`（`:37081-37083`），是共享 app 身份不是用户凭据 |
| Raccoon | `:37591` | `raccoon` | — | 手机号+二维码+阿里云 captcha 登录页 `:42605-42965` |
| MiniMax Code | `:49282` | `minimax` | `MINIMAX_ACCESS_TOKEN`（`:49293`） | OAuth 设备码：`/oauth2/device/code`、`/oauth2/token`（`:49295-49296`） |
| ZCode（智谱） | `:43613` | `zcode` | — | 验证码载体/串行队列：`zcode-captcha.ts:43677`、`serial-queue.ts:45383`、`captcha-carrier.ts:45060` |
| Gemini Code Assist | `:49724` | `gemini` | `GEMINI_ACCESS_TOKEN`（`:49726`） | 过期提前量 `GEMINI_EXPIRY_LEAD_MS=6e4`（`:49721`） |
| （opencode） | `:52344` | `opencode` | — | 被显式关闭：`worker.mjs:153` / `index.js:1028` 传 `disableOpencode: true` |

账号环境变量前缀映射表：`business.mjs:27990-28009`（LOBSTERAI/QODER/QODERCN/TRAE/CLINE/LOOMY/RACCOON/MINIMAX/ZCODE/GEMINI）。同处注释明确要求按前缀长度降序匹配（`:28015-28018`），否则 `QODERCN_*` 会被静默归到 `qoder`。

能力（capability）不是 provider 级一刀切，而是模型级：`supportsImage` / `supportsThinking` / `efforts` / `contextWindow` / `maxTokens` 挂在每个模型行上（Qoder 兜底表 `:32461-32537`、`:32611-32683`）；`inputModalitiesFor` 按远端 `supportsImage` 判定 vision（`:31245-31250`、`:33560-33567`）。统一 API 侧再折算成 OpenAI 形状（`worker.mjs:75-79`：`vision`、`context_window`、`max_tokens`）。

### 1.2 contracts.mjs 定义的契约

`packages/standalone/channels/contracts.mjs` 只有 37 行，是一层极薄的宿主无关契约：

- `Service`（`:4-9`）：构造时 `platform.provide(name, this)`，渠道服务只持有本实例的平台接口，不依赖 Cordis。
- `LlmAdapter`（`:12-20`）：`listProviders` / `listModels` / `resolveModel` / `stream` 四个必须实现，基类对未实现者显式抛错（`:13-16`，"渠道未实现…"），`prepareCall` 默认把 `resolveModel` 结果包成 `{model, stream}`（`:17-19`）。
- `LlmError`（`:21-27`）：带 `code` 的错误类型。
- 品牌化空函数 `credentialRef` / `ReasoningEffortId` / `ToolCallId`（`:28-30`）—— 运行期恒等，只做类型标记；`createUserMessage`（`:31`）补 `id`+`role`。
- 错误码常量（`:33-35`）：`CONTEXT_WINDOW_EXCEEDED`、`EMPTY_RESPONSE`、`QUOTA_EXCEEDED`，配 `isContextWindowExceededError` / `isQuotaExceededError`（`:36-37`）。

宿主适配层（`worker.mjs:19-59`）把 DSH 的 ctx 形状伪造出来：`platform.channelHome`、`credentials`、`logger`、`attachments`、`connection.fetch.register`、`provide/get/inject/effect/emit`，以及 `llm.registerAdapter/listProviders/listModels/resolveModel/resolveModelInfo/stream`。重复注册会抛错（`:40`、`:24`），这是「一实例一 Worker」的护栏。

渠道管理面（登录、账号池、模型黑名单）不走 llm 契约，走内部 HTTP route `/api/channel-pack`：`worker.mjs:82-91` 用 `routes.get('/api/channel-pack')` 造一个 `client-request`（`rpcId: 'standalone'`、`method: 'channel-pack'`）再解 `reply.result`。

做法：`cat -n` 整读 chan-relay/channel/contracts/credentials/runtime/worker/images、`grep -n` 抽 business.mjs 符号
判据：11 个渠道 id 全部定位到 business.mjs 行号；contracts.mjs 37 行读完，4 个 adapter 方法 + 3 个错误码
产物：`research/代理机制/05-渠道凭据与LAN中继.md` §1

## 2. 凭据生命周期

> 本节只写字段名、文件路径与权限位，不含任何真实 token / cookie / 密钥值。

### 2.1 token 存在哪里（四层，互不覆盖）

| 层 | 位置 | 权限/原子性 | 内容（字段名） | 依据 |
|---|---|---|---|---|
| pack 凭据仓库 | `<channelHome>/channel-credentials.json` | `mode 0o600`，temp+`rename` 原子写 | 顶层是 `{ <ref>: <字符串> }`；值是各 provider 自己 `JSON.stringify` 的凭据对象（如 `access_token`、`expires_at`、`expire_time`） | `packages/standalone/channels/credentials.mjs:7,19-27`；写入点 `business.mjs:41645-41647`（`credentials.set(ref, JSON.stringify(credential))`）、`:38341-38343` |
| 账号池索引 | `<home>/channel-pack/state.json` | FileStore，无显式 mode | `accounts[]`：`id` / `provider` / `nickname` / `enabled` / `credentialRef` / `createdAt` / `expiresAt` / `refreshable`；另有 `disabledModels`、`providerOrder`、`gatewayEnabled`、镜像字段 `loomyPermanentLocked` | `business.mjs:28156`、`:38351-38361`、`:28114-28126` |
| 网关自有密钥 | `<home>/openai-gateway/api-key` | `mode 384`（0600），temp+rename | 单行 43 字符 base64url；env `DSH_OPENAI_GATEWAY_API_KEY` 优先 | `business.mjs:55899-55903,55905-55906,55920`；插件侧读取镜像 `src/chan-relay.js:64-74` |
| 插件自有状态 | `<DSH_HOME>/our-free-model/*.json` | `mode 0o600`，temp+rename | settings（含 `aggregate.providers.*.apiKey`、`forwardKey`、`forwardLanKey`、`chanGateway.relay.key`）、stats、feed 缓存、`eac-user.json`（`token`/`login`/`avatar`/`savedAt`） | `src/store.js:24-28,110`；`src/store.js:199-205`；`src/eac-user.js:24-28,61-73` |
| EAC 密封 | `src/vault-data.js`（`LANE_SHARDS`、`LANE_SEAL`）+ `src/vault-anchor.js`（`LANE_ANCHOR`） | 编译进包，无运行期文件 | 密文 `iv\|ciphertext\|tag`；明文结构 `{v,m,u,t,k|s}` | `src/vault-data.js:2-3`；`src/vault-anchor.js:2`；`src/vault.js:141-164` |

凭据 ref 的合法性由仓库自身把关：`/^[A-Za-z0-9_.-]{1,200}$/`，不合法直接 `TypeError`（`credentials.mjs:16`）；`set` 只接受字符串（`:35`）；`dispose()` 把内存表清空（`:43`）。

迁移兜底：当 `state.json` 缺失但 `$DSH_HOME/.credentials.yaml` 存在时，按 ref 名反推账号索引并立即落盘；昵称/顺序/限流时间戳**无法**恢复（`business.mjs:28104-28126`）。

### 2.2 登录流程类型（五种，按 provider 混用）

1. **浏览器回调式（两步契约）**：`startLogin()` 立刻返回 `{loginUrl, result, close}`，`result` 是 promise，落库在 `persistLogin`（`business.mjs:38319-38331`、`:38341-38370`）。LobsterAI `:38319`、Qoder `:38908`、TRAE `:39648`、Cline `:40375`、Raccoon `:43082` 同形。LobsterAI 另有 `/auth/callback` 与 exchange/refresh 端点（`:29360-29361,29364`）。
2. **GitHub 设备码**：Cline 用 `device_code` / `user_code` / `verification_uri`（`business.mjs:40139-40168`）；MiniMax 用 `/oauth2/device/code` + `/oauth2/token`（`:49295-49296`）。
3. **短信验证码**：Loomy `sendSmsCode(phone)` 返回 `msgid`，提交验证码时必须原样带回（`:41611-41615`）；Raccoon `sendRaccoonSmsCode(product, phone, captchaParam)` 带阿里云 captcha 参数（`:42117-42121`）。
4. **扫码式**：Loomy 微信扫码 `startWechatLogin()` 起本地服务器承载弹窗页，**长轮询**直接拿 code，不碰回调页（`:41625-41634`，注释说明官方用 `will-redirect` 截获而回调页实测 404）；结果由 `persistWechatLogin` 单独落库并领每日额度（`:41649-41660`）。Raccoon 是二维码 + 手机号绑定页，内嵌阿里云 captcha SDK（`generateQrCode:42076`、`login_with_qrcode_code:42087`、页面 `:42605-42965`）。
5. **自动浏览器 + 验证码载体**：ZCode 走 `zcode-login.ts:45459` + `zcode-captcha.ts:43677` + `captcha-carrier-server.ts:45175`；`business.mjs:43631-43632` 的注释明确记了两个已知坑：上游静默超时失效、以及 captcha 里**无上限等待**（取页自旋、等 CDP WebSocket open）。

### 2.3 加密与密钥来源（vault-anchor）

- 只有 EAC 密封是真加密；其余全是 0600 明文 JSON。
- 算法：AES-256-GCM，AAD 固定 `ofm-eac-desktop/v1`，IV 12 字节、tag 16 字节，密文布局 `iv|ciphertext|tag`（`src/vault.js:34-36,141-147`）。
- 密钥**不落盘**：三片掩码分片（两片在 `vault-data.js`、一片在 `vault-anchor.js`，`vault.js:97-99`）各自用 HKDF(seed, pepper, "shard-mask") 解掩码（`:84-91`），拼接后再 HKDF-SHA256(salt=`ofm-lane-seal/1\0co-paid\0desktop-only`, info=`seal-open/ aes-256-gcm/ per-request`) 派生 32 字节 key（`:31-33,110-113`）。任何单文件或包内子串搜索都重构不出凭据（`:6-9`）。
- 派生不等于开门：`unlockSealedLane` 先过宿主闸门 `detectSealedHost`（`:73-81`）——Tauri 三要素（home 含 `com.deepseek.dsh.desktop.aio` + `resources\node\node.exe` + argv 含 `web-desktop`，`:75-77`）、Electron/kernel `profileName ∈ {desktop,tauri}`（`:79`）、web/web-desktop（`:78`）。非三态一律返回 null，车道全暗：不发请求、不出清单、不做密文运算（`:11-18,208-212`）。
- 每次请求重开密封，明文不跨调用帧（`:200-203`）。
- 生成工具在仓外：`scripts/mint-eac-seal.mjs`，三份 32 字节随机分片 + 12 字节 IV，写盘后回读验证，成功失败都不打印配置值/路径/原始异常；两份文件必须成对替换（`docs/eac-seal-migration.md:27-29`）。

### 2.4 刷新与失效

- 通用提前续期：`RefreshScheduler`（`business.mjs:38095`）+ `computeFirstRefreshDelayMs`（`:38086`，过期前 1 小时触发）。
- 每 provider 各有一个 `isXExpired` 判据：LobsterAI `:29436-29437`、Qoder `:31926-31927`、TRAE `:34085-34086`、Cline `:35948-35949`、Loomy `:37053-37054`、Raccoon `:37472-37473`。
- Loomy 刻意**不**武装 `RefreshScheduler`：它不可续期，武装只会「1 小时后触发 → 必然 RefreshTokenExpiredError → 调度器停摆」；健康检查改由 `refreshAll(pool)` 承担，30 分钟一次，只探测已过期账号（`:41580-41607` 注释）。`scheduleRefresh()`/`stop()` 是有意空实现。
- 网关侧：`resolveGatewayConfig` 端口非法直接抛错（`business.mjs:49033-49041`）；`api-key` 文件内容不是 43 字符 base64url 时抛错而**不静默重建**，否则已配好的客户端会全部失效（`:55912-55917`）。

### 2.5 明文风险点

1. `channel-credentials.json` 与 `state.json` 都是明文 JSON，安全性完全依赖 `0600` + 目录权限；`state.json` 连 mode 都没显式设置（`business.mjs:28156`）。
2. 插件 settings 是单个明文 0600 JSON，同时装着 `aggregate.providers.*.apiKey`、`forwardKey`、`forwardLanKey`、`chanGateway.relay.key`（`src/store.js:199-205,183-185`）—— 一次读文件即全量泄露。
3. relay key 会明文经 HTTP API 返给设置页：`index.js:1241` `key: () => chanRelayKey()`（页面要能复制）。这条通道的可达性只靠 `src/trust.js` 那层栅栏，不靠 key 本身。
4. `eac-user.json` 明文存 `token`（`src/eac-user.js:63-68`）；它是「这台机器是哪个用户」的唯一凭据，被拿走即可冒用该安装的协付额度，只能靠服务端撤销。
5. product 常量里内嵌第三方 app 身份（Loomy `accessKeyId/accessKeySecret/appId`：`business.mjs:37081-37083`；Qoder `clientId`：`:32545-32546`）—— 属共享 app 身份而非用户凭据，但泄露后可被拿去伪造同款客户端。
6. 密封能防的是「包内明文」，防不住宿主：拿到 `desktop` profile 的运行环境就能解开（`vault.js:53-61` 自己写明 profile 名是唯一权威判据）。

做法：`cat -n src/vault.js src/vault-data.js src/vault-anchor.js src/eac-user.js`，`grep -n` 抽 `RefreshScheduler|expiresAt|api-key|state.json`
判据：四层存储路径 + 五类登录流程 + 三片 HKDF 派生链全部落到行号；vault-data/vault-anchor 只读结构未输出值
产物：`research/代理机制/05-渠道凭据与LAN中继.md` §2

## 3. LAN 中继双密钥

`src/chan-relay.js` 全文 193 行。它服务的对象不是本插件的免费车道，而是被吸收的 channel pack 自带的那个 OpenAI 兼容网关（固定绑 loopback，`business.mjs:49026-49027` `127.0.0.1:8326`）。中继 = 用户指定地址上的第二个监听，用**本插件自己的 key** 收客，再用**网关自己的 key** 转发。

### 3.1 双密钥模型

| | relay.key（调用方） | gateway key（上游） |
|---|---|---|
| 谁生成 | 插件：首次访问 `chanRelayKey()` 时 `generateKey()` 铸造并落盘，`rotateChanRelayKey()` 轮换 | 网关自己：`randomBytes(32).toString('base64url')` 写 `openai-gateway/api-key`（`business.mjs:55919-55920`） |
| 存哪 | settings `chanGateway.relay.key`（`index.js:674-680`） | `<home>/openai-gateway/api-key`，或 env `DSH_OPENAI_GATEWAY_API_KEY`（`chan-relay.js:64-74`） |
| 谁能看见 | 设置页（`index.js:1241` 明文返回）、拿到该文件的人 | **只有宿主进程**：仅在转发跳上被贴上（`chan-relay.js:142-144`），从不发给中继的任何客户端（`:13-15`） |
| 校验 | `keyMatches(bearerOf(req), settings.lanKey)`（`:122`），兼容 `Authorization: Bearer` 与 `x-api-key`（`:173-176`） | 由网关自己校验；中继只做「有没有」检查（`:134-137`） |

分隔点写得很直白：调用方的 key 在门口就止步，网关只看到属于这台机器的 key（`:142-144` 注释）。`keyMatches` 来自 `src/forward.js`（`chan-relay.js:26`），是常量时间比较。

### 3.2 防环 / 白名单 / CORS

- **HOP_HEADER** = `x-ofm-chan-relay-hop`（`:29`）。转发时写入 `'1'`（`:145`）；收到带该头的请求立刻 508（`:126-129`），文案就是「中继在拨自己，给它一个独立端口」。
- **FORWARDED_PATHS**（`:32-37`）= `/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/reasoning-efforts`，只此四条；其余路径在转发任何一个字节之前就 404（`:18-19,130-133`）。路径先做尾部斜杠归一（`:110`）。
- **CORS**：`access-control-allow-origin: *`、`GET, POST, OPTIONS`、允许 `authorization, content-type, x-api-key`（`:39-43`）。`OPTIONS` 一律 204 且**不校验 key**（`:112-116`，理由：浏览器无法在预检上带 key，而答一次预检不花钱）。
- 转发时删 `host`/`connection`/`x-api-key`（`:139-141`）；回包删 `connection`/`keep-alive`/`transfer-encoding`（`:154-157`）；调用方断开则 `target.destroy()`（`:167-169`）。

### 3.3 监听地址来源

- 绑定参数只在启动时读一次：`boot = config()`（`:181`），`host` 缺省 `127.0.0.1`，`port` 非正数则 0（内核分配临时端口）（`:182-187`）。其余字段（enabled / key / gatewayKey / gatewayHost / gatewayPort）**每请求**读 `config()`，所以改设置不需要重新绑定（`:96-98,117`）。
- 改 host/port 必须重建：`index.js:711` 用 `chanRelay.host === host && chanRelay.port === port` 判等，不等则 close 再 start（`:713-725`）；实际绑定到的端口回写 settings，保证页面显示的就是应答的地址（`:744-746`）。
- 设置页只允许 `127.0.0.1 / localhost / 0.0.0.0 / ::`（`index.js:1226-1231`），`localhost` 归一成 `127.0.0.1`。
- 网关地址来源：`chanGatewayHome`（`chan-relay.js:51-57`，`DSH_CHANNEL_PACK_STATE_DIR` → `profileContext.home` → `DSH_HOME` → `~/.dsh`）、`chanGatewayPort`（`:77-82`，env `DSH_OPENAI_GATEWAY_PORT`，缺省 8326，非法值回落 8326）、`chanGatewayEnabled`（`:89-93`，只有显式 `0/false/off/no` 才关，理由见注释：`parseInt('0') || 1` 那类解析会让开关关不掉）。

### 3.4 错误码

| 状态 | type/code | 触发 | 行 |
|---|---|---|---|
| 401 | `invalid_request_error` | 缺 key 或 key 不匹配（`missing or invalid relay key`） | `:122-125` |
| 503 | `service_unavailable` | 中继被设置关掉 | `:118-121` |
| 503 | `service_unavailable` | 网关还没有凭据（先去网关页开一次） | `:134-137` |
| 508 | `server_error` | 命中 HOP_HEADER，自环 | `:126-129` |
| 404 | `not_found_error` | 路径不在白名单 | `:130-133` |
| 502 | `server_error` | 上游连不上 / 请求过程抛错 | `:161-165`、`:103` |

启动期错误不走 HTTP，而是写进状态：端口与网关撞车时 `chanRelayError = 'the relay needs a port of its own (the gateway listens on N)'`（`index.js:719-721`）；异常时 `chanRelayError = error.message`（`:748`）；两者都经 `chanRelayStatus().relay.error` 暴露（`:753-770`），且 `relay` 段只回 `hasKey` 布尔、不回 key 本身（`:760`）。standalone 打包版把启动失败统一成 `LAN relay could not start (<CODE 或 START_FAILED>)`（`packages/standalone/service.mjs:203`）；desktop 版是 `DATA_DIRECTORY_IN_USE` / `START_FAILED`（`packages/desktop/service-host.mjs:41`）。

**别混淆**：`src/forward.js` 里还有另一套 LAN relay（`forward.lan`，`forward.js:499-538`），它的双密钥是 `lanKey` vs `localKey`，目标是本插件自己的转发监听（`index.js:632-643`），与 chan-relay 是两条独立通道。

## 4. 进程模型与并发

### 4.1 进程模型：worker_threads

`packages/standalone/channels/runtime.mjs` 用 `new Worker(new URL('./worker.mjs', import.meta.url))`（`:2,8-11`），不是 `child_process`。`workerData = { dataDir }`，`execArgv` 过滤掉 `--input-type`（`:10`，否则 worker 会按 ESM 输入类型解析出错）。设计理由写在 `:6`：**一实例一 Worker**，避免原渠道业务的模块单例串目录、串账号。

worker 端（`worker.mjs`）第一件事就是 `createCredentials(workerData.dataDir)`（`:18`），再伪造 ctx（`:19-59`），最后 `apply(ctx, { disableOpencode: true })` 并 `send({type:'ready', providers})`（`:153-154`）。关闭时按 `cleanups.reverse()` 逆序执行，再 `credentials.dispose()`（`:131-138`）。

### 4.2 消息协议与并发

- 主→worker：`models` / `rpc` / `complete` / `cancel` / `close`（`worker.mjs:129-151`）。
- worker→主：`ready`（带 providers）/ `log` / `changed` / `result` / `chunk` / `error`（带 `statusCode`）/ `closed`（`runtime.mjs:35-52`）。
- **并发不排队**：每次 `call()` 取自增 `sequence` 作 id，直接 `postMessage`（`runtime.mjs:56-68`）；`pending` 是 `Map<id, entry>`，靠 id 分流回包。worker 端为每个 id 建一个 `AbortController`（`worker.mjs:140-141`），`finally` 删除（`:150`）——即**无全局并发上限，只有逐请求取消**。真正的串行化在 pack 内部（`model-queue.ts:32810`、`serial-queue.ts:45383`，按命名推测为每模型/全局串行队列，未细读）。
- 流式回包：`chunk` 逐条 `entry.onChunk`，若 onChunk 抛错则 reject 该 entry 并立刻发 `cancel`（`runtime.mjs:48-49`），避免半截流继续烧额度。
- 目录刷新去抖：worker 发 `changed` → 200ms 后 `refresh()`（`runtime.mjs:39-45`）；并发 `refresh()` 合并成一个 promise（`:71-75`）。

### 4.3 超时与回收

| 场景 | 超时 | 行为 | 行 |
|---|---|---|---|
| `call()` 缺省 | 120 000 ms | 定时器触发 `abort` → `postMessage({type:'cancel', id})` + reject | `runtime.mjs:53,59-64` |
| `rpc` | 10 分钟 | 同上 | `:84` |
| `complete` | 30 分钟 | 同上 | `:97` |
| worker ready | 30 000 ms | `readyReject('渠道初始化超时')`，随后 `runtime.close()` | `:133-137` |
| close | 1 500 ms 宽限 | 先 `postMessage close` 等 worker 自己收尾，超时再 `worker.terminate()` | `:119-128` |

所有 `setTimeout` 都 `unref()`（`:64,43,124`），不让统计/定时器拖住进程退出。worker `error` 或非正常 `exit` 时 `rejectAll`，把 `failed` 记下来，之后任何 `call()` 直接 reject（`:30-34,54`）。`runtime.state()` 因此只有 `ready` / `failed` 两态（`:78`）。

### 4.4 顺带的统计与图片边界

- `complete()` 在 `finally` 里回写 `recordUsage` / `recordTurn`（`runtime.mjs:101-111`），字段含 `origin:'forward'`、`ttftMs`、`decodeMs`、`noUsage`、`aborted` —— 与 `src/store.js:345-417` 的落库形状对齐。
- `images.mjs` 只在本请求内存里活：校验 magic（PNG/GIF/JPEG/WEBP）与真实尺寸，类型与字节不符或超 8192×8192 / 20 MiB 直接抛错（`images.mjs:36-37`），`attachmentId` 是 `sha256:<hex>`（`:38`），`readImage` 只接受带 `data` 的引用，拒绝任意路径读取或远程下载（`:3,40-43`）。

做法：`cat -n src/chan-relay.js packages/standalone/channels/runtime.mjs worker.mjs images.mjs`，`grep -n` 抽 START_FAILED 与 chanGateway 引用
判据：6 个 HTTP 错误码 + 3 处启动期错误串 + 5 个超时值全部定位；确认是 worker_threads 而非 child_process
产物：`research/代理机制/05-渠道凭据与LAN中继.md` §3-§4

## 5. EAC 协付

EAC 是本插件唯一「带密钥出门」的车道，也是唯一做了加密存储的车道。三个文件分工：`eac.js` 出网、`eac-login.js` 登录交接、`eac-user.js` 本地用户授权落盘。

### 5.1 两种车道模式（由密封决定）

| 模式 | 密封载荷 | 出门带什么 | 泄露后果 | 依据 |
|---|---|---|---|---|
| `direct` | `{u, k}`：网关 base + relay 凭据 | `authorization: Bearer <k>` | 直接就是凭据，必须吊销/轮换 | `vault.js:162-164`；`eac.js:160` |
| `worker` | `{u, s}`：签名网关 base + 共享签名密钥 | 无秘密，只有 HMAC 签名 + 时间戳 | 是**间接**入口，网关换掉接受的密钥即可吊销 | `vault.js:155-160`；`eac.js:4-13` |

`worker` 模式额外要求 base 以 `/v1` 结尾（`vault.js:158`），因为网关只放行 `/v1/models` 与 `/v1/chat/completions`。

### 5.2 签名怎么走

- 待签串：`<timestamp>\n<METHOD>\n<path>\n<sha256(body)>`，HMAC-SHA256，输出头 `x-ofm-timestamp` + `x-ofm-signature`（`eac.js:132-139`）。签名覆盖 body 哈希，所以 body 必须**逐字节**到达网关。
- 因此不走全局 `fetch`：`laneFetch` 直接压在 `node:http`/`node:https` 上（`eac.js:67-121`）。注释写明动机（issue #50）：别的插件替换 `globalThis.fetch` 并重序列化 body，HMAC 就会废掉，网关回 `request signature rejected`；而核心 `node:https` 换不掉（`:70-75`）。返回的是 Response 形状的 shim（`ok/status/headers.get/body/text()/json()`），body 是 `Readable.toWeb` 包装的 WHATWG 流，因此 `readHead/readSse` 照旧工作、首 token 不被缓存（`:77-83,98-112`）。
- 用户授权另走 `x-ofm-user` 头（`eac.js:149-158`）：未登录时缺省不带，网关回 401 AuthorizationRequired，设置页据此弹登录；listing 也带，省一套 wire shape。显式传 `null` 时必须隔离，独立应用未登录不能回退读 DSH 授权（`:156-158` 注释）。
- 请求面：`GET {base}/models`（15s 超时，`:34,174-198`）、`POST {base}/chat/completions`（300s，`:35,208-276`）。先 `readHead` 4096 字节 sniff body 判 `sse`/`empty`/JSON（`:237-243`），非流则整份折叠成一条 payload（`:245-274`）。前面挂了代理时常见整页 HTML 错误（Cloudflare 524），会被降级成一行「front proxy answered HTTP N with an HTML error page」（`:167-171,268-270`），并且**不进可重试的 SERVER 类**（`:263-267` 注释）。
- 测试缝：`lane.fetch` 与 `laneUser.token` 两个模块私有开关（`eac.js:44,51`），生产代码不碰。

### 5.3 服务端登录交接（eac-login.js + docs）

关联码 `link` 必须是 `^[A-Za-z0-9_-]{16,64}$`（`eac-login.js:4`）。三步：

1. **prepare**：`GET {root}/auth/github/start?link=<link>`，期望 **302**（Node 不跟随重定向，系统浏览器稍后打开）；非 302 归为 `gateway-http-<status>`（`:68-73`）。`root` 由 `credential.base` 去掉尾部 `/v1` 得到（`:25,68`）。
2. **poll**：`GET {root}/auth/poll?link=<link>&retain=1`，15s 超时（`:26-28`）。服务端状态机：`expired` / `pending` / `unstarred`（带 `login`、`repo`）/ `ok`（带 `token`），其余归 `malformed`（`:33-36`）。
3. **落盘 + ack**：先 `writeUser({token, login, avatar})` 再 `readUser()` 回读比对，不一致判 `not-writable`（`:38-39`）——**保存是提交点**。`ackRequired === true` 时才 `POST {root}/auth/ack?link=` 带 `x-ofm-user`，3s 超时，失败不影响已存的凭据（`:43-52`）。

会话簿记：收据 TTL 15 分钟（`:5,42`），同 `link` 并发 `poll` 合并成一个 in-flight promise（`:86-94`），`cancel()` 先看收据——已保存就报完成、绝不删已有授权（`:96-107`），`reset()` 换代作废所有在途（`:108-113`），代次不匹配即视为 `cancelled`（`:22,53`）。

服务端语义（据 `docs/`）：

- 领取协议三行表：旧客户端 `GET /auth/poll?link=`（幂等重复领取至过期）／新客户端 `&retain=1`（返回 token + `ackRequired:true`，确认前保留同一令牌最多 15 分钟）／`POST /auth/ack?link=` 带匹配 `x-ofm-user`（确认后移除，重复确认幂等 200）（`docs/eac-server-login-handoff.md:61-63`）。
- 待领取令牌加密落盘在 `users.json`（0600），同存储路径与密钥下可跨**单实例**重启恢复；未实现多实例共享（同上 `:69`）。
- 强制鉴权开关 `REQUIRE_USER_TOKEN`：`0` 是兼容期，不会阻止正确登录；开启后无 `x-ofm-user` 但签名有效的请求返回 401/AuthorizationRequired（同上 `:119,195-204`）。密钥/用户存储不得在修复时轮换（`:118`）。
- 客户端修复要点：`retain=1` + 原子写回读 + ACK、新旧网关兼容、同码并发合并、退出后迟到响应保护、串行重试、等待态恢复与取消（`docs/eac-login-delivery.md:9-12,40-41`）。本地回环联调通过不等于远端 520 已解决（`:17,45`）。

### 5.4 eac-user.js 语义

`readEacUser` 缺 `token` 即视为未登录（`eac-user.js:37-52`）；`writeEacUser` 拒绝空 token、目录 `0700`、文件 `0600`、temp+rename，写失败返回 `null` 而不抛（`:61-73`）；`clearEacUser` 只删本地文件，服务端令牌另行撤销（`:75-83`）。设计意图写在 `:5-9`：密封装的是**所有安装共享**的网关地址与签名密钥，这个文件才是「本安装是哪个用户」——GitHub 登录 + star 判定在服务端签发、服务端可撤销。

## 6. trust 与 feed

### 6.1 trust.js 保护什么

保护对象：**本插件注册的 HTTP 面**（设置页 API 与 `/api/channel-pack` 等），不是 relay 的 key 校验。漏洞前提写得很清楚：插件注册的前缀比内核 `/api` **更长**，而 webServer 是 longest-prefix-wins，所以这些路由跑在 connection 服务自己的准入检查**之前**，否则会应答任何 loopback 调用者（`trust.js:4-7`）。

两层，按序：

1. 有 `connection` 服务就用它——即内核给 `/api` 的同一套准入决定（trust fence + 浏览器 auth cookie），保证插件不比宿主更弱（`:9-13,96-109`）。兼容两代命名：`admit`（返回 `{rejection}` 信封）与旧版 `requestRejection`（返回裸 status）（`:61-75,90-108`，issue #89）。
2. 没有该服务时用**结构复刻**：Host 必须是 loopback 名单（`127.0.0.1/[::1]/::1/localhost`，`:23,139`）；`sec-fetch-site: cross-site` 直接拒（`:140-141`）；带 `Origin`/`Referer` 时必须与 Host 的 scheme/hostname/port **三者全等**（`:142-157`）——注释点明：web server 在 loopback 上跑的是纯 http，声称 https 的 Origin 就不是本页。

**失败行为**（关键）：挂载的 Host 服务抛错时返回 **503 `admission-error`**，绝不因为「服务坏了」而放行（`:110-113`，注释原话「Never bypass browser authentication when a mounted Host service fails」）；结构层判负返回 403（`:117,132-134`）。诊断回调只拿固定字段 `{status, source, reason}`，从不含 header 或错误正文（`:83-85,119-123`）；reason 也是固定枚举（`host-not-loopback` / `cross-site` / `<header>-invalid` / `<header>-mismatch` / `desktop-relay-markers`），不透传调用方字符串（`:136-158`）。

桌面例外：`dsh-app://app` 的 relay Referer 被放行，但前提是**没有** `origin` 也没有 `sec-fetch-site`（`:145-150`），且它永远不覆盖已挂载 Host 的认证决定（`:147-148`）；`isDesktopRelayReferer` 只认 protocol/hostname/port/无 userinfo 的组合（`:162-170`）。

`isLoopbackHost`（`:31-39`）是另一个用途：判定 forward 监听**能否**绑该地址——车道按本机出口计价，绑可路由接口等于把额度送给整个子网（`:25-30`）。

### 6.2 feed.js：announcements / manifest

- **announcements**：仓库主人在自己 GitHub 仓库里编辑一个 JSON 即可发布，无服务器无部署；每次推送 `main` 就是发布动作（`feed.js:1-8`）。
- 三源按序：`raw.githubusercontent.com` → `cdn.jsdelivr.net` → `gh-proxy.com`（`:39-49`）。raw 优先是因为那是仓库自己的字节、中间没有第三方缓存；jsDelivr 是给 TLS 被干扰的网络的兜底；没有 `master` 回退，因为 GitHub 对该 ref 回 422（`:26-38`）。jsDelivr 每次抓取追加分钟级 cache-buster `?ofm=<分钟>`，破它的 12 小时边缘缓存（`:51-61`）。
- **频率**：`feedPollMinutes` 默认 30 分钟、下限 5 分钟（`src/store.js:233-234`）；`updateCheckHours` 默认 6 小时、0 关闭（`store.js:240-241`）。
- **校验**：整份文档校验，任何结构不符就整份拒绝而不是半应用（「渲染错的公告比迟到的公告更糟」`feed.js:9-12,76-92`）；上限 512 KiB 文档 / 96 KiB 单条 html / 100 条（`:64-66`）；`expiresAt` 已过期的条目在 ingest 时丢弃（`:105`）；`id` 去重（`:82-90`）；排序 = pinned 优先再按 `createdAt` 倒序（`:131-137`）。
- **降级**：抓取失败只记 `this.error` 并**保留上一份缓存**（`:265-268`），视图同时给 `error`/`lastError`（`:301-308`）；成功即 temp+rename 落盘（`:276-287`）；`load()` 从磁盘恢复公告与 `knownIds`，坏缓存当空处理（`:188-205`）；`poll()` 并发合并（`:247-250`）；`onArrival` 只在「本来有缓存」时才算新到达，镜像源回退造成的重复 id 不算到达（`:252-262`）。
- **来源约束**：`feedUrl` 覆盖必须 https 且无内嵌凭据，loopback http 例外（本机镜像与测试），不合格就忽略并回落默认源（`:222-240`）。
- **manifest** 属更新通道，不在这里：feed 明确不读 `feedUrl` 之外的更新源，更新清单由 `src/updater.js` 自己管（`feed.js:220-221` 注释）；`distribution: 'managed'` 的安装会把自更新、公告 feed、热重载一起停掉（`store.js:246-251`）。

做法：`cat -n src/eac.js src/eac-login.js src/eac-user.js src/trust.js src/feed.js`，`grep -n` 抽 eac-*.md 端点/协议表
判据：三种 EAC 请求面 + 三步登录交接 + trust 两层与 503/403 分支 + feed 三源与降级路径全部落到行号
产物：`research/代理机制/05-渠道凭据与LAN中继.md` §5-§6

## 7. 复用手册

要把「渠道登录 + 凭据存储 + LAN 中继」搬到别的宿主，按下面六个模块切，接口按最小面收。整块搬 pack 是不可能的（61 698 行、内嵌 10 个 provider 的协议细节），但边界是干净的。

### 7.1 模块边界与最小接口

| 模块 | 从哪抄 | 最小接口 | 不许知道的事 |
|---|---|---|---|
| **M1 凭据仓库** | `credentials.mjs`（45 行，可直接用） | `resolve(ref) → {value, source} \| undefined`；`describe(ref)`；`set(ref, string)`；`unset(ref)`；`dispose()` | 不解析凭据内容、不知道 provider；ref 白名单 `/^[A-Za-z0-9_.-]{1,200}$/`、写值必须 string、temp+`rename`+`0600`、`closed` 后拒写 |
| **M2 账号索引** | `business.mjs:28156` + `:38351-38361` | `accounts() → [{id, provider, credentialRef, expiresAt, refreshable, enabled}]`；`addAccount(rec)`；`removeAccount(id)`；`setDisabledModels` | 不知道 token 值；`state.json` 只存 ref 名，token 在 M1 |
| **M3 登录编排** | `business.mjs` 各 `startLogin` + `loomy/raccoon` 扫码流程 | 统一两步契约：`startLogin(opts) → {loginUrl, result: Promise<credential>, close()}`；扫码/短信额外 `sendSmsCode(phone) → msgid`、`submitCode(msgid, code)` | 不碰磁盘（落库在 M4）、不管续期（M5） |
| **M4 落库与续期** | `persistLogin`（`:38341-38370`）、`RefreshScheduler`（`:38095`）、`computeFirstRefreshDelayMs`（`:38086`） | `persist(credential, {refName, accountId, pool}) → {ref, expires, refreshable}`；`scheduleRefresh()` / `refreshAll(pool)`；每 provider 一个 `isExpired(credential) → bool` | 不可续期的 provider 必须**显式**不武装调度器（Loomy 的反面教材 `:41580-41607`） |
| **M5 LAN 中继** | `src/chan-relay.js`（193 行，可直接用） | `startChanRelay({config, log}) → {host, port, close()}`；`config() → {enabled, host, port, lanKey, gatewayHost, gatewayPort, gatewayKey}` | 不生成 key、不落盘、不管 UI；只做「双密钥 + 防环 + 白名单 + CORS」 |
| **M6 准入栅栏** | `src/trust.js`（184 行，可直接用） | `rejectionFor(req, connection?, onRejection?) → status \| undefined`；`isLoopbackHost(value) → bool` | 不知道业务路由；只回固定 status/reason，绝不透传 header |

关键纪律（照抄即可）：

1. **双密钥永不合并**：调用方 key 与上游 key 在同一个函数里只碰一次面（`chan-relay.js:138-145`），上游 key 不进任何响应体、不进日志。状态接口只回 `hasKey: boolean`（`index.js:760`）。
2. **host/port 与其余字段分离生命周期**：host/port 只在 bind 时读一次、改动要重建监听；其余字段每请求读 `config()`（`chan-relay.js:96-98,181-187`）。这样设置页保存不需要重启。
3. **先归一化再判等**：路径去尾斜杠（`:110`）、`localhost → 127.0.0.1`（`index.js:1230`）、端口非法回落默认（`chan-relay.js:77-82`）。
4. **准入失败必须失败关闭**：服务抛错 → 503，不是放行（`trust.js:110-113`）。这条是整个 HTTP 面最容易写反的地方。
5. **凭据只在调用帧内活**：M1 的 `resolve` 结果直接交给请求构造器然后丢弃；密封版更彻底——每请求重开（`vault.js:200-203`）。
6. **落库即提交点**：先写后回读比对，再对外宣告成功（`eac-login.js:38-39`）；取消/退出逻辑必须先看「是否已提交」再决定删不删（`:96-107`）。

### 7.2 最小可用骨架

```
host
 ├─ credentials (M1)         ← dataDir/channel-credentials.json  0600
 ├─ accountIndex (M2)        ← dataDir/channel-pack/state.json
 ├─ loginFlows (M3)          ← 每 provider 一个 adapter，统一 {loginUrl, result, close}
 ├─ persist+refresh (M4)     ← 写 M1、登记 M2、武装 scheduler
 ├─ trustFence (M6)          ← 先于任何业务路由
 └─ relay (M5)               ← config() 每请求读；host/port 变更才重建
```

顺序有依赖：M6 必须在路由注册时就在链路最前（否则长前缀绕过准入）；M1 必须先于 M4；M5 只依赖 M1 之外的一个只读 `gatewayKey` 取值函数（本仓里是 `chanGatewayCredential`，`chan-relay.js:64-74`）。

### 7.3 直接可复用 / 需重写

- **可原样搬**：`credentials.mjs`、`chan-relay.js`、`trust.js`、`src/channel.js`（40 行，单产单消异步通道，`push(undefined)` 结束、`push(Error)` 抛错）、`images.mjs`。
- **需适配宿主**：`runtime.mjs` + `worker.mjs`（把 DSH ctx 换成目标宿主的 ctx；`worker_threads` 可换 `child_process`，但「一实例一 Worker」的隔离结论要保留）、`store.js`（DSH home 解析、`STATS_VERSION` 迁移链）。
- **不建议搬**：`business.mjs` 里 10 个 provider 的协议细节（客户端常量、验证码载体、签到、额度领取）——按需挑一个 provider 重写比整体搬运便宜。

## 8. 未确认项

1. **MiniMax / Gemini 的登录入口**未逐行确认。只有 product 常量与 OAuth 路径常量（`business.mjs:49282-49300`、`:49724-49740`），未见 `startLogin` 实现段落。推测：MiniMax 走设备码（`/oauth2/device/code` → `/oauth2/token`，`:49295-49296`），Gemini 走 access_token 导入或 Google 设备码（`parseGeminiCredential` 只认 `access_token`，`:49729-49736`）。
2. **Qoder 的 wasm 用途**未确认。`vendor/channel-pack/qoder-auth-wasm.wasm`（298 KB）+ `business.mjs:31978` `qoder-wasm.ts`，推测是设备指纹/请求签名（与 `encryptedInferBase` `:32546` 配套），未读实现。
3. **ZCode 的验证码载体链**只看了符号：`captcha-carrier.ts:45060`、`captcha-carrier-server.ts:45175`、`zcode-carrier-page.ts:45341`、`serial-queue.ts:45383`。推测是本地起页 + CDP 驱动阿里云滑块，未验证。
4. **并发闸门位置**：`model-queue.ts:32810`、`serial-queue.ts:45383` 按命名推测是每模型/全局串行队列，未读实现，故「无全局并发上限」的结论只覆盖 `runtime.mjs` 这一层。
5. **`vendor/channel-pack/pack.js` 与 `packages/standalone/channels/business.mjs` 是否同版本**未逐段比对（前者 61 708 行、后者 61 698 行，差 10 行，推测是同源的两次 esbuild 输出）。
6. **relay key 明文的实际暴露面**：`index.js:1241` 把 key 明文返回给设置页，这条路由的可达性依赖 `trust.js`；未实测「非本机/跨站请求能否拿到该响应」。
7. **`state.json` 的文件权限**：`FileStore` 构造处（`business.mjs:28156`）未见显式 mode，实际落盘权限取决于进程 umask，未实测。
8. **`docs/eac-server-login-handoff.md` 的远端状态**：文档自述远端 520 根因未定位、`REQUIRE_USER_TOKEN` 实际生效状态未复核（`:213`），属文档承认的未知项，非本次勘察可判定。

做法：`cat >>` 分段追加 §7/§8，`wc -l` 校验
判据：文档 8 节齐全、每节结论带 `文件:行号`、无任何真实凭据值、未确认项 8 条且区分「推测」
产物：`research/代理机制/05-渠道凭据与LAN中继.md`（终稿）
