# dsh-agy 架构（ARCHITECTURE）

> 目标：**深模块**（小接口 + 大实现），4 个真正的 seam，2 个薄壳。
> 不模仿 opencode 插件的平面文件堆叠（其 `request.ts` 1881 行 / `request-helpers.ts` 2856 行交叉依赖，是拦截架构下有机生长的产物）；继承它的**领域划分与 schema**，按深模块重组。

## 1. 模块图与 seam

```
                     ┌─────────────────────────────────────────┐
                     │  index.ts（插件壳：name/apply，约 100 行） │
                     │  注册 adapter + webServer 路由 + 初始化    │
                     └───────┬──────────────┬──────────────────┘
                             │              │
            ┌────────────────▼───┐   ┌──────▼─────────┐
            │ adapter/           │   │ web/           │
            │ AgyAdapter          │   │ /agy 路由+HTML  │
            │ （DSH 指定 seam）    │   │ （薄壳）         │
            └────────┬───────────┘   └──────┬─────────┘
                     │                      │
            ┌────────▼──────────┐   ┌───────▼─────────┐
            │ runtime/          │   │ cli/            │
            │ 分类/轮换/指纹状态机 │   │ dsh-agy 子命令   │
            │ （深模块）          │   │ （薄壳）          │
            └────────┬──────────┘   └───────┬─────────┘
                     │                      │
            ┌────────▼──────────┐   ┌───────▼─────────┐
            │ store/accounts    │   │ oauth/          │
            │ 接口 + JSON 实现   │   │ 纯函数深模块      │
            │ + 测试 fake        │   │ authorize/      │
            └───────────────────┘   │ exchange/       │
                                    │ refresh/        │
                                    │ bootstrap/blob  │
                                    └─────────────────┘
```

依赖方向：`oauth/`、`store/` 是叶子（无内部依赖）；`runtime/` 依赖两者；`adapter/`、`cli/`、`web/` 三个调用方共享同一组深模块（**leverage**：一个实现服务三个入口 + N 个测试）。

## 2. 深模块清单（seam = 接口所在处）

| 模块 | 接口（小） | 实现（大，藏在里面） | 测试面 |
|---|---|---|---|
| `oauth/authorize` | `authorize(projectId?) → {url, verifier, state}` | PKCE、state 编解码、scope 集合 | fixture：URL 参数断言 |
| `oauth/exchange` | `exchange(code, state) → {tokens, email, projectId}` | 多端点 fallback、伪装 UA、userinfo、错误形状解析 | fixture：成功/失败 payload |
| `oauth/refresh` | `refresh(auth) → auth` | 刷新、60s 缓冲过期、invalid_grant 吊销、`refresh\|projectId` 打包 | fixture |
| `oauth/bootstrap` | `bootstrap(token) → {projectId, tier}` | loadCodeAssist / onboardUser、重试、time-box | fixture |
| `oauth/blob` | `encode/decode(blob)` | 前缀校验、provider 绑定防重放 | 纯单元 |
| `store/accounts` | `load() / save(acc) / mutate(fn)` | 加密、proper-lockfile、迁移链、去重、0600 | **in-memory fake**（第二个 adapter，正当的 seam） |
| `runtime/classify` | `classify(error) → Kind` | 429/403/网络错误解析、Retry-After、resetTime | fixture |
| `runtime/rotation` | `onFailure(acc, kind) → Action` | 冷却到服务端上报的真实 reset 时间（上限 30min/24h）、backoff 分级、activeIndex 切换、指纹再生触发 | 状态机单元测试 |
| `runtime/quota` | `rank(accounts, model) → order` | fetchAvailableModels → 按模型族（google/anthropic/openai）聚合配额、drained/hot-window 护栏、required-drain 排名（对齐 OMP） | 纯单元 |
| `runtime/risk` | `isDisabled() / fingerprintMode()` | 环境开关：总开关 + 固定身份模式（自备客户端凭据在 oauth/constants 解析） | 纯单元 |
| `runtime/fingerprint` | `generate() → Fingerprint` | 随机平台/arch/SDK 池、历史管理（≤5）、版本同步；**数据外置 JSON** | 纯单元 |
| `adapter/translate` | `toBody(generateOptions) → RequestBody` | DSH messages/tools → Gemini contents[]，thinking 原样携带 | fixture（录制请求） |
| `adapter/parse` | `fromSSE(line) → Chunk[]` | SSE 行解析、candidates[] → StreamChunk、usage/错误事件 | fixture（录制响应原文） |
| `adapter/models` | `listModels() / resolveModel(id)` | fetchAvailableModels 拉取 + 目录元数据合并 + 过滤 + 降级 | fixture |

## 3. 薄壳（刻意浅，不抽象）

- `cli/` 各子命令：读 store → 调 oauth/runtime → 打印。不做"命令框架"，commander 直接驱动。
- `web/routes.ts`：webServer handler → 调同一组模块。HTML 内联（单文件页面，原生 JS），不引入前端框架。
- `adapter/adapter.ts`：`LlmAdapter` 子类仅做编排（取 token→刷新→翻译→流式→分类错误），翻译/解析在深模块里。

## 4. 排除项（为什么不做）

| 参考项目模块 | 为什么排除 |
|---|---|
| `recovery.ts`（会话恢复） | 拦截架构并发症：注入合成 tool_result 修补打断的工具调用。DSH 的 adapter 无状态，loop 持有历史并自管重试（`llm/stream` 错误协议 / `agent/request-error`） |
| `thinking-recovery.ts` + warmup | 根源是"剥离 thinking 规避签名校验"；我们原样携带 reasoning 块，无此问题 |
| `cross-model-integration.ts` | DSH 历史是 provider-neutral 块，loop 负责跨模型连续性；该模块源码在 archived 仓库中已删除 |
| gemini-cli 头风格/双配额池 | Google 已不支持该客户端路径；单一配额池简化轮换 |
| 模型族拆分 `activeIndexByFamily` | 单个亲和 pin + 模型族配额排名（`runtime/quota`）已覆盖需求，无需按族维护独立 activeIndex |
| 插件 Config（schemastery） | 无插件 Config schema——风险管控走纯环境开关（`runtime/risk`） |

## 5. 目录树（最终形态）

```
dsh-agy/
├── package.json            # name: dsh-agy, type: module, bin: dsh-agy, dsh.bundle patch
├── tsconfig.json / vitest.config.ts
├── LICENSE (MIT)
├── README.md               # 英文；灰区功能风险声明
├── cordis.patch.yml        # 挂载条目（dsh plugin add 生效）
├── docs/                   # ARCHITECTURE / ANTIGRAVITY-API（中英双语）
├── scripts/
│   ├── record-fixture.ts   # 真实账号录制（登录/模型/流式/刷新）
│   └── e2e.ts              # 本地 e2e（env 注入 token，不进 CI）
├── src/
│   ├── index.ts            # 插件壳
│   ├── types.ts / invariant.ts
│   ├── oauth/  store/  runtime/  adapter/  cli/  web/
└── tests/
    ├── fixtures/           # 录制 payloads（脱敏）
    └── *.test.ts           # Vitest，fixture 驱动
```

## 6. 测试面总览（接口即测试面）

- 所有深模块的测试**跨同一 seam** 进行（fixture 数据 → 模块接口 → 断言），不测内部。
- `store` 的 seam 由 in-memory fake 坐实（测试第二个 adapter）。
- 429/配额路径：fixture 覆盖（构造真实形状的 429 payload）；真实验证靠软配额前置观测 + 自然限流时刻。
- 收尾：REAL-composition 冒烟——DSH profile 挂插件，`ctx.llm.prepareCall → stream` 全链路一次。