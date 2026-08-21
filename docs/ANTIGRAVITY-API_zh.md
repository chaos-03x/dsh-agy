# Antigravity 上游协议事实（ANTIGRAVITY-API）

> 从两个参考项目代码核对的事实清单（非推测）。wire 格式以本项目 `scripts/record-fixture.ts` 录制结果为准（可能随 Google 端迭代漂移）。

## 1. 端点与环境

| 环境 | 基址 | 状态 |
|---|---|---|
| Production | `https://cloudcode-pa.googleapis.com` | 对 consumer OAuth 账号实测 429（企业/license 用途） |
| Daily | `https://daily-cloudcode-pa.googleapis.com` | **consumer 账号主端点（实测 200）**；来源：OmniRoute runtime 链首位 |
| Daily (Sandbox) | `https://daily-cloudcode-pa.sandbox.googleapis.com` | 实测可用（fallback）；来源：CLIProxy/Vibeproxy 实践（opencode 常量注释），OmniRoute 仅 discovery 链收录 |
| Autopush (Sandbox) | `https://autopush-cloudcode-pa.sandbox.googleapis.com` | 实测 403（consumer 无 license），链尾兜底；来源：CLIProxy 实践，OmniRoute 未收录 |

已知环境限制：上游可能返回 `FAILED_PRECONDITION: User location is not supported for the API use`
（网络出口地理位置不支持），与代码无关。

OAuth 端点（固定）：授权 `https://accounts.google.com/o/oauth2/v2/auth`；token `https://oauth2.googleapis.com/token`；userinfo `https://www.googleapis.com/oauth2/v1/userinfo?alt=json`。

## 2. 动作

| 动作 | 路径 | 用途 |
|---|---|---|
| 流式生成 | `POST /v1internal:streamGenerateContent?alt=sse` | 主通道 |
| 非流式生成 | `POST /v1internal:generateContent` | 降级 |
| 项目发现 | `POST /v1internal:loadCodeAssist` | 登录后拿 projectId / tier |
| 新账号引导 | `POST /v1internal:onboardUser` | 无项目账号的 onboarding（带 `tier_id` + 仅 `{ideType:"ANTIGRAVITY"}` metadata；重试 3 次 + 3-7s jitter，ban-safety——固定节奏长循环像脚本自动化） |
| 模型发现 | `POST /v1internal:fetchAvailableModels` | 每模型 `quotaInfo`（remainingFraction/resetTime） |
| 模型列表（备选） | `/v1internal:models` | 第二条路 |

## 3. 认证与头

- `Authorization: Bearer {access_token}`；`Content-Type: application/json`；流式加 `Accept: text/event-stream`。
- `User-Agent: antigravity/{version} {platform}/{arch}`（platform ∈ {windows, darwin}，arch ∈ {amd64, arm64}；版本号需保持新鲜——外置 JSON）。
- `X-Goog-Api-Client`：池 `google-cloud-sdk vscode_cloudshelleditor/0.1`、`vscode/1.86.0`、`vscode/1.87.0`、`vscode/1.96.0`。
- `Client-Metadata` 代码实际只发 `{ideType:"ANTIGRAVITY"}`（凭空多发的 `platform`/`pluginType` 会被后端枚举校验拒绝）。
- 双风格（antigravity vs gemini-cli）**不做**。
- **请求 envelope（OmniRoute 活跃格式）**：顶层 `{project, requestId, model, userAgent:"antigravity", requestType:"agent", request:{contents, tools?, toolConfig:{functionCallingConfig:{mode:"VALIDATED"}}, generationConfig?, sessionId}}`。Claude 模型剥离尾部 model 轮；工具 schema 被裁剪到上游 allowlist 并归一化关键字值（后端拒绝任何未知关键字**以及**任何不符合 protobuf 形状的值；见 §3.1）。

### 3.1 工具 Schema 契约（实测确认；防打地鼠防线）

后端把工具 `parameters` 按严格的 protobuf `Schema` 解析：未知关键字（`$schema`、`propertyNames`、`pattern`、`minLength`、……）与非法值形状（`enum: [true]` → TYPE_STRING 400；`type: ["string","number"]` → Unknown name "type" 400）都会使整个请求失败。清洗器（`src/adapter/translate.ts` 的 `sanitizeToolSchema`）执行的是完整契约，而非逐关键字打补丁：

- **关键字** — 只保留 `type, format, title, description, nullable, items, enum, default, properties, required, additionalProperties`。
- **值** — `type` 必须是单个枚举字符串（union 数组归一化为首个非 `null` 类型，`"null"` 对应 `nullable`）；`enum` 项必须是字符串（非字符串项被过滤，空 enum 整体省略）；`properties` 是 name→schema 映射；`items` 是嵌套 schema；`additionalProperties` 接受嵌套 schema 或布尔（`false` = 禁止额外键；Antigravity 上游活体验证接受——OmniRoute 剥离仅因公共 Gemini API 拒绝）；`required` 是字符串数组。
- **工具名** — `functionDeclarations[].name` 只接受 `[a-zA-Z0-9_]` 且 ≤64 字符（MCP 工具名任意；清洗，超长/重名追加 sha256 尾）。内置 Gemini 工具名（`google_search`、`web_search`、`search_web`、`googleSearch`）整体剔除（上游将其视为原生工具）。
- **测试** — `tests/adapter.test.ts` 的 `assertUpstreamContract` 递归断言清洗后输出的每个关键字与值形状均合规，任何新未知关键字或非法值形状都会在 CI 失败（不必等用户撞 400）；每个已知的 400 形状都以 fixture 钉住。真实 MCP schema（GitHub MCP `issue_write` 正是 #4 触发源：boolean enum + union type）应进入语料，以暴露手写测试看不到的形状。

## 4. OAuth 细节

- client_id `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`（Antigravity 桌面客户端，公开凭据；secret 经 OmniRoute `resolvePublicCred` 模式处理）。
- scopes：`cloud-platform` + `userinfo.email` + `userinfo.profile` + `cclog` + `experimentsandconfigs`；**不加 openid**。
- `access_type=offline`、`prompt=consent`、可选 PKCE S256、`state` 编码 `{verifier, projectId}`。
- **Google `firstparty/nativeapp` consent：仅当 loopback redirect 可达时才释放 code** → 远程必须走粘贴 blob（`omniroute-cred-v1.` + base64url）。
- token 交换失败错误形状多变：`error` 字符串 / 对象（`code|status|message`）/ `error_description`。

## 5. 响应结构

- 生成响应：Gemini `candidates[]` 风格（`parts[]`、`text`、`thought` 块、`functionCall`），SSE 事件逐行解析；附加 `x-antigravity-*` 元数据头（token 计数等）。
- **工具调用签名（协议硬性要求，实测确认）**：出站 `functionCall` part 必须带平级 `thoughtSignature`（缺则 400 "Function call is missing a thought_signature in functionCall parts"）；响应侧 functionCall part 携带该签名（`{thoughtSignature, functionCall:{id,name,args}}`），须按 `functionCall.id` 捕获并在下一轮重放；无缓存时以 `skip_thought_signature_validator` sentinel 兜底（两个参考实现均默认）。并行 functionCall 的签名语义见 OmniRoute openai-to-gemini.ts。
- **思考内容不下发（实测确认）**：`usageMetadata.thoughtsTokenCount` 报告思考 token 数，但所有模型（gemini-3.6-flash-high / gemini-3-flash-agent / claude-opus-4-6-thinking / gemini-2.5-flash-thinking，含显式 `thinkingConfig`）的流式响应**均无 `{thought:true}` part**——思考要么蒸馏进最终 `text`（3.5 Flash 系把推理写进回答），要么完全隐藏（Claude 系直接输出答案）。DSH 前端因此不会有 reasoning 块；parse 保留 thought part 支持仅为防御性。
- `fetchAvailableModels`：`{models: Record<id, {quotaInfo?: {remainingFraction, resetTime}, displayName, modelName}>}`；**无能力元数据**（contextLength 等需本地目录补齐）；含不可聊天模型需过滤。
- **图像输入（Gemini `inlineData` part）**：包裹体即 Gemini Content proto JSON，因此用户图像块翻译为 `parts: [{inlineData: {mimeType, data}}]`，字节以 base64 从 DSH attachment 服务解析（`ctx.attachments.readImage`），不带 `data:` 前缀；媒体类型取自 attachment ref。请求大小上限由部署方 attachment 限额决定；无逐请求图像 offload（需更新的 dsh-llm API）。`inlineData` 的上游接受性由一次性探针 `scripts/probe-image.mts` 实测（用已配置账号发一张极小 PNG）。tool result 内嵌图像与 assistant 侧图像不可表示、直接以 `UNSUPPORTED_CONTENT` 拒绝；纯文本目录模型（`gpt-oss-*`）同样拒绝图像。
- **推理元数据**：对于固定档模型，思考档位由模型 id 固定（`-thinking` / `-high` / `-medium` / `-low`），因此 `supportsReasoning` 映射为单一固定 effort `on`（defaultEffort `on`）。对于动态阶梯模型（`gemini-3.7-flash-tiered` / `gemini-3.6-flash-tiered`），`supportsDynamicReasoning` 提供 4 档可选强度：`off`（0 tokens，关闭思考）、`low`（2048）、`medium`（8192，默认）、`high`（24576），出站线格式直接映射为 `generationConfig.thinkingConfig.thinkingBudget`（并自动保证 `maxOutputTokens` 高于 budget 以防 400）。非推理 id（如 `gemini-2.5-flash`）不提供推理控件。
- 配额语义：`loadCodeAssist`/`fetchAvailableModels` 的 `quotaInfo` 为单一配额源（不做 retrieveUserQuota/GeminiCLI UA 路径）。
- **隐式缓存上报（实测确认）**：`usageMetadata.cachedContentTokenCount` 并非总是出现——只有缓存已预热且前缀足够大时才上报（gemini 系 ~16k+ 前缀、约第 3 个请求起命中；claude 系预热更快、可第 2 个请求即命中且命中率 ~99%）。单轮/小前缀请求一律缺失该字段，不代表模型不支持缓存。实测脚本 `scripts/probe-cache-context.mts`（三模型均复现：gemini-3.7-flash-tiered / gemini-3-flash-agent / claude-opus-4-6-thinking）。
- **缓存键 = 前缀内容，与 sessionId 无关（实测确认）**：`scripts/probe-cache-loss.mts` 用与先前 probe 逐字节相同的 20.5k system 前缀 + 全新 sessionId，第一轮即命中 20447 tokens——缓存按前缀哈希跨 session 共享。DSH 新对话首轮 0% 的真实原因是 system 前缀 ~13.5k < 16k 阈值（从未被缓存）且各对话历史不同，不是 sessionId 隔离。
- **缓存写入异步、滞后约 2 轮、按块批量（实测确认，命中率上限的根因）**：请求体逐字节前缀完全一致（append-only 构造）时，`cached` 仍每轮少于上一轮完整 prompt——命中前缀以"上一轮新增块"为单位跳升（实测每次恰好 +4086 = 一个填充块），写入滞后约 2 轮；稳态每轮未命中 ≈ 1.5-2× 每轮新增 → 命中率上限 ~88-92%。对比 DeepSeek 的即时完整写入（每轮未命中 ≈ 仅新增 → ~99%），这是 agy 命中率到不了 99% 的根因；上游行为，不可控。
- 错误分类输入：HTTP 状态 + `Retry-After` / resetTime / 错误 JSON 形状 → runtime/classify。通用 400 归为 `request-error`（永久性——重试只是重发同一份坏 payload，不做轮换）；仅容量类 400（上下文溢出 / 模型不可用）为 transient。

## 6. 模型集

- 对照目录：OmniRoute `AGY_PUBLIC_MODELS`（从 live endpoint pin 的快照：gemini-3.6-flash-high/medium、Claude 系列、GPT 系列；含 contextLength/maxOutputTokens/supportsReasoning/supportsVision/toolCalling）。**相对快照的修正**：Gemini 系原生多模态，所有 `gemini-*` 条目均声明 `supportsVision`（快照漏标了 2.5 Flash / 3.1 Flash Lite 档）。`supportsVision` 驱动 DSH 的 `inputModalities`（图像能力标注 + 图像准入闸门），`supportsReasoning` 驱动单一思考控件（见 §5）。目录缺失的动态模型 id 保持无标注（未知，而非文本-only）。
- 别名映射参考 OmniRoute `antigravityModelAliases.ts`（仅当 fixture 实测发现 id 差异时引入）。