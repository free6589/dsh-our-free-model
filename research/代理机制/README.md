# dsh-our-free-model 代理机制研究

对象：`Ebony-Vinyl/dsh-our-free-model` v2.5.9，main @ `38e0a94`。
本地 fork：`free6589/dsh-our-free-model`（本目录所在仓库）。
研究方式：六路子代理并行静态考古（`sed -n` / `grep -n` 逐段读源码），
每条结论带 `文件:行号`；无证据处标「推测：」。**唯一动态验证**见 06 分册 §7。

## 一句话结论

这个插件不是"一个代理"，而是**三条车道 + 一层与上游无关的网关**：
`src/forward.js` 的 `startForwardServer()` 只认一个 `complete()` 回调，
于是同一端口同时说 OpenAI 与 Anthropic；所有上游差异（免费车道指纹、十个账号渠道、
EAC 协付、Kilo）都被关在 `complete()` 背后。

## 怎么读

| 你是 | 从哪读起 |
| --- | --- |
| 想立刻复用这套网关 | **06-复用指南** §1-§2（20 行可跑示例）+ §7（实测输出） |
| 想知道请求怎么走 | **02-转发主链路** §1 逐跳序列 |
| 想改配置/排障 | **08-配置与端点速查** |
| 想知道模型怎么被选中 | **03-路由与出口** |
| 想接自己的上游 | **06** §4（改动面封闭的四点）+ **04** §1 provider 契约 |
| 想搞清楚凭据与局域网 | **05-渠道凭据与LAN中继** |
| 想逆向同类闸门 | **07-上游闸门逆向笔记** §2 方法论 |
| 第一次接触这个仓库 | **00-总览与文件地图** |

## 分册

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `00-总览与文件地图.md` | 129 | 快速上手、三条车道、核心对象、文件地图、错误码表 |
| `01-入口与网关.md` | 367 | cordis 装配、provider 注册、gateway 生命周期、端点表、standalone、管理 RPC |
| `02-转发主链路.md` | 493 | 逐跳调用链、请求体构造、头部与会话、SSE、重试策略、deferred |
| `03-路由与出口.md` | 422 | 复合 id 解析、7 级错误分类、单出口切换、探测冷却、combos、effort |
| `04-协议适配与变换.md` | 391 | provider 鸭子契约、Anthropic↔OpenAI 映射、消息归一、token-saver、目录签名 |
| `05-渠道凭据与LAN中继.md` | 314 | 11 个渠道 id、四层明文凭据、双密钥中继、worker_threads、EAC |
| `06-复用指南.md` | 216 | 唯一复用缝、最小可跑实现、三档分类、坑清单、**实测验证** |
| `07-上游闸门逆向笔记.md` | 94 | v2 指纹闸门全表、逆向方法论、失效信号与对照表 |
| `08-配置与端点速查.md` | 85 | settings 字段、环境变量、端口、端点、改了不生效的三种情况 |

## 十条最值得记住的发现

1. **网关与上游解耦**：`startForwardServer({config, complete, modelRows, …})`（`src/forward.js:325`），
   `complete(request, onChunk) → {text, toolCalls, usage}` 是唯一契约。
2. **同一端口双协议**：`/v1/chat/completions`、`/v1/responses`、`/v1/messages` 全在
   `src/forward.js:375-390` 一处分发，无转译 shim。
3. **`/health` 故意免鉴权**（`src/forward.js:355`），在 key 校验之前。
4. **三把 key 互不复用**：forward key（`ofm-`+24B，`src/forward.js:100`）、
   插件线 LAN key、渠道中继 key（`index.js:553/567/674`）。
5. **免费车道的闸门是客户端指纹**，不是账号：UA 整串匹配、四会话头同值、
   session id 必须是降序 `~(ms<<12|counter)`、`read`/`shell` 工具定义逐字一致
   （`src/upstream.js:70/137/151/337` + `docs/free-lane-wire.md`）。
6. **`tool_calls[].index` 必须从 0 重编号**，否则按 index 累积的客户端拿到带洞数组（issue #20）。
7. **非流式也别信 `Content-Type`**：上游会在 JSON 头下回 SSE 帧，按首字节嗅探（issue #6）。
8. **重试只对 4 类错误**：`EMPTY_RESPONSE`/`SERVER`/`TIMEOUT`/`TRANSPORT`，
   2 次、700ms 起、8s 上限、抖动 0.2（`src/adapter.js:75-89`）；
   `RATE_LIMIT` 与 region 码**故意不重试**（issue #13）。
9. **凭据大多明文**：`channel-credentials.json`(0600)、`channel-pack/state.json`、
   `openai-gateway/api-key`、DSH settings JSON；只有 EAC 密封是 AES-256-GCM 且密钥不落盘
   （`src/vault.js:97-113`）。
10. **自动可用性探测已被 owner 策略停用**（`src/store.js:163-165`），只有手动重探会发请求。

## 三处「题面假设与代码不符」（子代理主动纠正）

| 假设 | 实际 |
| --- | --- |
| `src/route/` 有路由表 | 只有 `classify.js`（错误分类），分派在 `src/adapter.js:324-326` + `src/core/runtime.js:418-437` |
| `egress.js` 是出口池 + 打分 | 单一可切换出口（`src/egress.js:89` 单例），多 IP 由 mihomo `url-test` 在进程外做（`:678-685`） |
| adapter 有 `generate`/`abort` | 只有 `stream()`（`src/adapter.js:162-190`），取消走 `options.signal` + 迭代器 `return()` |

## 未确认项汇总（各分册共 50+ 条，此处只列共性）

- 宿主内核侧行为（`registerAdapter` 校验清单、`dsh.client` 语义、探活调度周期）不在本仓库，只能从调用点反推。
- `vendor/channel-pack/pack.js`（61708 行）与 `packages/standalone/channels/business.mjs` 是否同版本未验证。
- `/v1/reasoning-efforts` 的响应形态属 vendor，本仓库只做中继白名单透传。
- 文本侧计价规则不在本仓库；catalog 无定价字段，只有 `imageRequestPricing()`。
- 除 06 分册 §7 那次本地桩测试外，**全部结论来自静态阅读**，未发真实上游请求。

## 复现研究结论

```bash
cd /home/fish/projects_mine/dsh-our-free-model
# 06 分册的实测：用桩 complete() 起网关，验六条路径
node research/代理机制/gw-smoke.mjs
# 全量回归（原作者提供）
npm run selftest
npm run test:contributor
```
