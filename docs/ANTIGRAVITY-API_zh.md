# Antigravity 上游协议事实（ANTIGRAVITY-API）

> 线路事实测量自已安装的官方产物及其发布源。社区多账号项目是**线索（LEADS）而非参照物**：它们模仿的是不同产品、彼此矛盾，并停在其编写时的版本。wire 格式以本项目录制结果为准（可能随 Google 端迭代漂移）。

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
| 新账号引导 | `POST /v1internal:onboardUser` | 无项目账号的 onboarding（带 `tier_id` + body 的 `metadata` 消息；重试 3 次 + 3-7s jitter，ban-safety——固定节奏长循环像脚本自动化） |
| 模型发现 | `POST /v1internal:fetchAvailableModels` | 每模型 `quotaInfo`（remainingFraction/resetTime）；同时携带角色列表与 `tieredModelIds` |
| 配额窗口 | `POST /v1internal:retrieveUserQuotaSummary` | 5 小时与每周窗口的**唯一**来源（按组，而非按模型）——见 §5 |
| 模型列表（备选） | `/v1internal:models` | 第二条路 |

## 3. 认证与头

- `Authorization: Bearer {access_token}`；`Content-Type: application/json`；流式加 `Accept: text/event-stream`。
- `User-Agent: antigravity/{version} {platform}`——**没有** `/{arch}` 段。`{platform}` 来自 UA 令牌池（外置 JSON，尚未从官方二进制捕获）；它与下方 `ClientMetadata.Platform` 的 Go 风格枚举是**两套不同的词汇**。版本号需保持新鲜——外置并动态解析。
- `X-Goog-Api-Client`：池 `google-cloud-sdk vscode_cloudshelleditor/0.1`、`vscode/1.86.0`、`vscode/1.87.0`、`vscode/1.96.0`。
- **不存在 `Client-Metadata` 请求头**——它已被移除，两个官方二进制中都没有该名称。客户端身份走请求 **BODY** 的 `metadata`（`ClientMetadata`），携带 `ideType`、`ideVersion`、`platform`，每者都有已捕获的词汇表。旧的「只允许发 `ideType`」说法**作废**：实测拒绝发生在**值** `"MACOS"` 上，而它不是 `Platform` 枚举成员（`platform` 接受枚举**名**，如 `DARWIN_ARM64`，而不是 UA 令牌 `darwin/arm64`）。`pnpm run verify:metadata-acceptance` 会以旧 body 作对照重新测量接受度。
- 双风格（antigravity vs gemini-cli）**不做**。
- **请求 envelope（OmniRoute 活跃格式）**：顶层 `{project, requestId, model, userAgent:"antigravity", requestType:"agent", request:{contents, tools?, toolConfig:{functionCallingConfig:{mode:"VALIDATED"}}, generationConfig?, sessionId}}`。Claude 模型剥离尾部 model 轮；工具 schema 被裁剪到上游 allowlist 并归一化关键字值（后端拒绝任何未知关键字**以及**任何不符合 protobuf 形状的值；见 §3.1）。
- **`contents` 合并（相邻同角色归并，functionResponse 族感知）**：harness 产出碎片化的分步词汇——问题、runtime-context 快照、`<system-reminder>` 注入各自是独立的 `user` 消息，每个工具结果各一条消息——而它自己的第一方序列化器会在 wire 边界合并相邻同角色消息，故 `translate.ts` 在 1:1 映射之后执行 `coalesceContents`：并行工具结果聚合为**单个仅含 `functionResponse` 的 user 轮**，相邻文本轮合并为一轮。`functionResponse` part 绝不与 text 同轮——模型族校验器拒绝二者混合的 user content（经 langchainjs#11445 实测 400；本信道对混合形状的容忍度未测量）——因此 fr 轮与随后的文本轮保持相邻分离。投影为零 parts 的 model 轮（Claude 路径的 thoughts-only 轮）会使其前后的 user 段融合；文本占位符等于捏造模型发言、结构性空轮在本信道未测量，故该融合被钉死为已知行为（issue #93）。**`functionResponse` 的 name 解析按 id 先进先出（FIFO）**：工具调用 id 在一次会话中并非唯一——存在时由 provider 下发，缺省时 harness 自己的组装器回落到 `call-<blockIndex>`（按消息计），而 `parse.ts` 回落到 `String(blockIndex)`（按流计，计数器每次流从 0 重新开始）——因此相隔很远的两个轮次完全可能回答同一个 id，而 Google 会用 `name` 去校验该响应所回答的那次调用：第 12 轮的 `job_output` 结果顶着第 23 轮 `bash` 的 name，让**整段历史**被 400 `INVALID_ARGUMENT` 拒绝，且这是永久性的，因为重试只会重放同一段历史（issue #99）。因此 `translate.ts` 按文档顺序保留同一 id 下记录到的每个 name，并在每个结果上消费最旧的那个。从未被记录过的 id 仍回落到原始 id（修复前的行为）——这是最后手段，因为 id 不是函数名，写上去必然 400；而**已耗尽的 id**（结果多于调用，即某次调用从历史中消失而其结果留下）用该 id 最后一次记录到的 name 作答：既然已无可配对，这个猜测在重复调用本就是同一工具时就是对的，而原始 id 在任何时候都是错的。两处缺口被刻意留下：重复 id 仍照原样上线（不去重，伪造 id 会错指一次真实调用），以及 `runtime/signature-cache.ts` 的 thought-signature 缓存正是以这个会冲突的 id 为键——那是一个单独跟踪的缺口，此处不修。Gemini 路径把 `functionResponse` 放在 user 轮已被实测接受，但从未从官方客户端捕获过该形状——社区抓包（lead 级）声称官方形状是放在调用轮之后的 model 角色轮；此处未验证。
- **generationConfig.thinkingConfig**（四种形态；前三种仅用于档位模型）：`catalog thinking!=='level'`、或既无 `reasoningEffort` 且 purpose 非 `session-title` 时**不带**。当 `GenerateOptions.purpose==='session-title'` 或 `reasoningEffort` 为 `none`/`off` 时发 **`{thinkingBudget:0}`**——用于抑制默认思考，避免其吃掉紧张的 `maxTokens` 上限（会话标题的 cap 很小）。当 `reasoningEffort` 为三档之一时发 **`{thinkingLevel:"low"|"medium"|"high", includeThoughts:true}`**。当配置了按档位预算时发 **`{thinkingBudget:N, includeThoughts:true}`**（完全替换该档的档位——两者绝不并行发送，因为同时存在时档位胜出、会让数值失效）；或在 Claude 路径上配置了 Claude 预算**且** `max_tokens` 严格大于它时。示例（当前 `gemini-3.7-flash-tiered`；未来 `gemini-4-flash` 无 `-tiered` 后缀但标 `thinking:'level'` 时行为一致）：`{"model":"gemini-3.7-flash-tiered","request":{"generationConfig":{"thinkingConfig":{"thinkingLevel":"medium","includeThoughts":true}}}}`。
- **「不带」这一支就是自适应（adaptive）路径，且用户可达。** `models.ts` 刻意不声明 `reasoning.defaultEffort`：harness 以 `effective = requested ?? reasoning.defaultEffort` 求值，且选择器的「provider default」项以 `defaultEffort === void 0` 为条件——声明它等于同时做两件事：给每个请求强加档位（`thinkingConfig` 恒存在），并删掉唯一表达「让模型自己决定」的选项。不声明时，选择器在 low/medium/high 之外提供 Default；选它则 `reasoningEffort` 为 undefined、本字段不带，由上游跑自己的预算。实测 `gemini-3.8-flash-tiered`：`fetchAvailableModels` 对每个 `*-tiered` id 都报 `thinkingBudget: -1` + `minThinkingBudget: 32`，且省略 `thinkingConfig` 返回 200，`thoughtsTokenCount` 随任务变化。
- **该通道接受显式数值预算**（与未来的预算设置相关）：可接受区间为 `[-1, 65535]`——`-2` 与 `65536` 均返回 400 并指明该区间。`{thinkingBudget:-1}`（自适应）本身即被接受，故自适应不必像另一实现那样用「省略字段」来表达。`0` 被接受、且确实**降低**思考，但**不能可靠地关闭**思考（四次实测 `thoughtsTokenCount` 为 53/69/126/67，而自适应路径为 112–236），故「0 = 关闭思考」不是可靠断言。`8192` 与 `32768` 返回 200 且 `thoughtsTokenCount` 上升。`{thinkingLevel:"auto"}` → **400** `Invalid value at 'request.generation_config.thinking_config.thinking_level'`，故档位词表封闭为 low/medium/high。以上全部由 `pnpm run verify:thinking-config` 重新测量——它已经抓出上面那条过宽的 `0` 断言。
- **`minThinkingBudget` 不是校验。** 低于模型自报下限的预算（如模型报 `32` 而传 `1`）返回 200，故它绝不能用作客户端钳制——钳制会拒绝后端本可接受的值。
- **本条中有两处结论已被小样本实测反证，不得视为已定。** (a) 上面「id 绑定模型带 level 会被 400 拒绝」未能复现：`gemini-3.6-flash-high`、`gemini-3.5-flash-low`、`gemini-2.5-flash`、`claude-opus-4-6-thinking` × low/medium/high（各 n=2）**全部 200**，且 id 绑定的 Gemini 上 `thoughtsTokenCount` 仍随档位变化。我们的代码不受影响（只在 `thinking:'level'` 时才发，id 绑定 id 依旧从不携带），但所述**理由**可能是错的。(b) §5 的「thoughts 从不流式输出」过宽：在 `gemini-3.8-flash-tiered` 上确实观察到 `{"thought":true,"text":...}` 分段，尽管该断言限定的四个模型都不是 `-tiered`。两句在改写前都需要专门的 `verify:*` 门禁重新测量。

### 3.1 工具 Schema 契约（实测确认；防打地鼠防线）

后端把工具 `parameters` 按严格的 protobuf `Schema` 解析：未知关键字（`$schema`、`propertyNames`、`pattern`、`minLength`、……）与非法值形状（`enum: [true]` → TYPE_STRING 400；`type: ["string","number"]` → Unknown name "type" 400）都会使整个请求失败。清洗器（`src/adapter/translate.ts` 的 `sanitizeToolSchema`）执行的是完整契约，而非逐关键字打补丁：

- **关键字** — 只保留 `type, format, title, description, nullable, items, enum, default, properties, required, additionalProperties`。
- **值** — `type` 必须是单个枚举字符串（union 数组归一化为首个非 `null` 类型，`"null"` 对应 `nullable`）；`enum` 项必须是非空字符串（非字符串与空字符串项都会被过滤——空项会 400 `cannot be empty`，已实测；全空的 enum 整体省略）；`properties` 是 name→schema 映射；`items` 是嵌套 schema；`additionalProperties` 接受嵌套 schema 或布尔（`false` = 禁止额外键；Antigravity 上游活体验证接受——OmniRoute 剥离仅因公共 Gemini API 拒绝）；`required` 是字符串数组。
- **工具名** — `functionDeclarations[].name` 只接受 `[a-zA-Z0-9_]` 且 ≤64 字符（MCP 工具名任意；清洗，超长/重名追加 sha256 尾）。内置 Gemini 工具名（`google_search`、`web_search`、`search_web`、`googleSearch`）整体剔除（上游将其视为原生工具）。
- **测试** — `tests/adapter.test.ts` 的 `assertUpstreamContract` 递归断言清洗后输出的每个关键字与值形状均合规，任何新未知关键字或非法值形状都会在 CI 失败（不必等用户撞 400）；每个已知的 400 形状都以 fixture 钉住。真实 MCP schema（GitHub MCP `issue_write` 正是 #4 触发源：boolean enum + union type）应进入语料，以暴露手写测试看不到的形状。

### 3.2 图片输入契约（经 OmniRoute 生产流量验证）

图片输入以 Gemini 风格 inline part 随 `contents[].parts[]` 发送；两类模型族共用同一契约：

- **Part 形状** — `{inlineData: {mimeType, data}}`（camelCase；`data` 为纯 base64，不带 `data:` 前缀）。图片媒体类型与 harness 附件词汇表一致：`image/png`、`image/jpeg`、`image/webp`、`image/gif`；非图片媒体类型仅对 Gemini 模型支持（见下）。
- **Claude 对等** — Claude 系模型使用相同的 `streamGenerateContent` schema；请求侧 contents 原样通过（无需 Claude 特有的图片处理）。非图片多模态文件绝不发送给 Claude（见下）。
- **executor 过滤安全** — 上游侧的 parts 归一化只丢弃空 `text`、无名 `functionCall` 与不可回放的 `thought` parts；`inlineData` parts 不受影响。
- **插件行为——图片** — 用户消息中的 image block 由持久附件服务解析出字节，在翻译前预转换为 base64（`src/adapter/adapter.ts`）；服务缺失或读取失败以 `UNSUPPORTED_CONTENT`（终态）硬失败，绝不静默降级为纯文本。tool-result 内嵌图片不做翻译。
- **插件行为——非图片多模态文件（仅 Gemini）** — `src/adapter/multimodal.ts` 还会把 DSH 文件句柄文本中的非图片文件解析为同一 `inlineData` part 形状，单文件上限可配置（默认 20MB，在 DSH 设置的「配置」标签页里改；生效优先级为环境变量 `DSH_AGY_MULTIMODAL_MAX_INLINE_MB` > 已保存设置 > 20MB 默认值，因此无头运行无需打开界面也能调整）。覆盖格式：`.pdf` → `application/pdf`（已对 Antigravity 用多页 PDF 实测通过）；音频 `.mp3/.wav/.m4a/.aac/.ogg/.flac`、视频 `.mp4/.mov/.webm` 与图片 `.bmp/.heic/.heif` 遵循 Gemini 公开的多模态支持，尚未实测。门控默认拒绝（`supportsMultimodalFiles`）：Claude 系模型一律排除（Vertex 对非图片 `inlineData` 返回 500）、catalog 模型必须具备视觉能力、catalog 未收录的 id 仅在 `gemini-` 前缀下放行。与图片路径不同，读取失败、超限或格式不受支持时静默回退：原文件句柄文本保留在 prompt 中，模型仍可用文件工具读取。
- 证据来源：OmniRoute 的 OPENAI→ANTIGRAVITY 翻译器在同一端点上产出该形状（其 Claude 路径白名单对 contents 原样放行）；自录 fixture 待补——发版前用真实账号实测一次。

### 3.3 Claude 路径的 `contents[]` part 契约（实测）

Claude 系模型由同一 `streamGenerateContent` envelope 背后的 **Anthropic 校验器**处理：错误以 Anthropic 原生形状返回（`{"type":"error","error":{"type":"invalid_request_error","message":"messages.N.content.M..."}}`），嵌在 Gemini 风格的 `error.message` 字符串里。有三种 part 形状 Gemini 路径接受、Claude 路径一律 400（全部实测；`pnpm run verify:claude-parts` 可复测每一行）：

| 被拒形状 | Claude | Gemini | 错误 |
|---|---|---|---|
| 空 text part（`{text:""}`） | 400 | 200 | `messages.N.content.M.text.text: Field required` |
| 缺 id 的 `functionResponse` | 400 | 200 | `messages.N.content.M.tool_result.tool_use_id: Field required` |
| 回放的 thought（`{thought:true,text}`） | 400 | 200 | `thinking.signature: Field required`；改用 `skip_thought_signature_validator` 哨兵则被拒为 `Invalid signature in thinking block` |

校验器按**翻译后请求内的下标**寻址 part（`messages.N.content.M`），因此错误文案能精确定位到出问题的 part——排查长历史里的 400 时很有用。

- **空 text** — DSH 在工具调用后会产出尾部零长 text block；上游自身的 parts 归一化也会丢弃空 `text`（§3.2），故 `translate.ts` 对所有模型族一律丢弃。
- **`tool_use_id`** — tool-call id 始终随 `functionResponse` 一起发送（`block.toolCallId`）；Gemini 接受该多余字段，故不按模型族分叉。
- **回放的 thought** — thought 只能由产出它的模型重新签名，而 functionCall 的哨兵不是合法的 thinking 签名，因此来自其它模型族的 thought **没有**任何合法形态。`translate.ts` 因此在 Claude 路径上丢弃 thought part。触发场景并不罕见：会话中途从 tiered Gemini 模型（agy 中唯一产出 `reasoning` block 的模型）切到 Claude 模型，该历史就会被回放。

## 4. OAuth 细节

- client_id `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`（Antigravity 桌面客户端，公开凭据；secret 经 OmniRoute `resolvePublicCred` 模式处理）。
- scopes：`cloud-platform` + `userinfo.email` + `userinfo.profile` + `cclog` + `experimentsandconfigs`；**不加 openid**。
- `access_type=offline`、`prompt=consent`、可选 PKCE S256、`state` 编码 `{verifier, projectId}`。
- **Google `firstparty/nativeapp` consent：仅当 loopback redirect 可达时才释放 code** → 远程必须走粘贴 blob（`omniroute-cred-v1.` + base64url）。
- token 交换失败错误形状多变：`error` 字符串 / 对象（`code|status|message`）/ `error_description`。

## 5. 响应结构

- 生成响应：Gemini `candidates[]` 风格（`parts[]`、`text`、`thought` 块、`functionCall`），SSE 事件逐行解析；附加 `x-antigravity-*` 元数据头（token 计数等）。
- **流终止：不存在 `data: [DONE]`（实测 2026-10-03，`daily-cloudcode-pa`，3/3 短流）**：正常流是一串 `data:` 行，终止于最后一个候选块携带 `finishReason` 的分块——SSE 的 `[DONE]` 约定解析器接受但线上从未观测到。推论：流终止判定必须 keyed on `[DONE]` 或 `finishReason` 任一（绝不能只认 `[DONE]`，否则所有真实流都会失败），而两者皆无的干净 EOF 是被截断的流，必须报错而不是 yield 默认 `stop`（issue #85：高负载下截断的回答被当作正常完成）。正常流中非 `data:` 行为零（实测 3/3）；干净关闭前出现的无 `data:` 前缀裸 `{"error":{...}}` JSON 行是错误路径而非帧——由 issue #85 的 socket 抓包报告（尚未独立复现），`parse.ts` 提取并显式报错。
- **零长度 text part 是常态（实测）**：tool-call turn 和流收尾会携带 `{thoughtSignature, text: ""}` part。空 text part 在重放时会被 Anthropic 兼容的 Claude 路径拒绝（`...text.text: Field required`），因此 `parse.ts` 直接跳过（issue #77）而不伪造空内容块——且跳过时不关闭已开的块，文本连续性不受影响——`translate.ts` 再对全 family 丢弃空 text/thought part（为解析器修复前已录制的历史兜底）。
- **退役的模型 id 会以 200 + 纯文本退役通知 + 无 `finishReason` 应答（实测 2026-10-04）**：`gemini-3-flash-agent` 返回了 "Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash in the latest version of Antigravity." 的普通文本后直接关流——#85 完整性守卫会正确地将其报告为被截断的流。discovery 仍会列出退役 id，因此选中过期 id 的失败形态是流错误而非干净的 model-not-found；verify 脚本必须优先使用已知活跃的 id 而非 discovery 顺序（`verify:contents-coalescing` 钉死了该模式）。
- **工具调用签名（协议硬性要求，实测确认）**：出站 `functionCall` part 必须带平级 `thoughtSignature`（缺则 400 "Function call is missing a thought_signature in functionCall parts"）；响应侧 functionCall part 携带该签名（`{thoughtSignature, functionCall:{id,name,args}}`），须按 `functionCall.id` 捕获并在下一轮重放；无缓存时以 `skip_thought_signature_validator` sentinel 兜底（两个参考实现均默认）。并行 functionCall 的签名语义见 OmniRoute openai-to-gemini.ts。
- **思考内容不下发（实测确认）**：`usageMetadata.thoughtsTokenCount` 报告思考 token 数，但所有模型（gemini-3.6-flash-high / gemini-3-flash-agent / claude-opus-4-6-thinking / gemini-2.5-flash-thinking，含显式 `thinkingConfig`）的流式响应**均无 `{thought:true}` part**——思考要么蒸馏进最终 `text`（3.5 Flash 系把推理写进回答），要么完全隐藏（Claude 系直接输出答案）。DSH 前端因此不会有 reasoning 块；parse 保留 thought part 支持仅为防御性。
- `fetchAvailableModels`：`{models: Record<id, {quotaInfo?: {remainingFraction, resetTime}, displayName, modelName}>}`；**无能力元数据**（contextLength 等需本地目录补齐）；含不可聊天模型需过滤。
- **`models` 之外的角色列表（真实账号实测确认）**：`tabModelIds`、`commandModelIds`、`imageGenerationModelIds`、`mqueryModelIds`、`webSearchModelIds`、`commitMessageModelIds`、`audioTranscriptionModelIds`（均为 id 数组）；`deprecatedModelIds`（以被弃用 id 为键的对象，不是数组：`{oldId: {newModelId, oldModelEnum, newModelEnum}}`）；以及三个正向信号 `defaultAgentModelId`、`agentModelSorts`（`[{displayName, groups:[{modelIds}]}]`）、`tieredModelIds`（`{flash|pro|flashLite: [id]}`）。角色列表里的 id 不遵循任何命名规律：`tabModelIds` 含 `chat_20706`，`tab_` 前缀判断抓不到；`mqueryModelIds`、`webSearchModelIds`、`commitMessageModelIds` 三者都指向 `gemini-3.1-flash-lite`，即目录里已 pin 的聊天模型。两个 id 可以共用同一个 `displayName`：`gemini-3.1-pro-high` 与其 `newModelId` `gemini-pro-agent` 都叫 "Gemini 3.1 Pro (High)"。
- **插件行为**：`mergeModelCatalog` 隐藏 `tabModelIds` / `imageGenerationModelIds` / `audioTranscriptionModelIds` 的成员，以及 `newModelId` 已存在、可聊天且未被角色隐藏的弃用 id（账号未携带替代模型时，被弃用 id 保留；替代模型是否可用只对照角色隐藏判断，因此弃用链的结果与键序无关）。工具类角色（command、mquery、webSearch、commitMessage）不参与过滤，因为它们指向的就是普通聊天模型。三个正向信号可否决隐藏，上游误标不会让可用模型消失。过滤只作用于 `listModels`：`resolveModel` 仍接受任意 id，配额视图（`dsh-agy status`、设置 → Antigravity 分区）仍统计 `models` 的全部条目。
- 配额语义：`fetchAvailableModels` 的 `quotaInfo` 是**逐模型**压力的来源（仅 `remainingFraction` + `resetTime`，实测所有 id 皆然，故它无法表达窗口），`loadCodeAssist` 提供 project/tier。它**不是**唯一配额源——此行原先「单一配额源、不做 retrieveUserQuota 路径」的结论据此更正。
- **`v1internal:retrieveUserQuotaSummary` 是 5 小时与每周窗口的唯一来源（实测确认）。** 响应形态：`{groups:[{displayName, buckets:[{bucketId, window, remainingFraction, resetTime, displayName, description}]}]}`。实测账号：分组 `Gemini Models`（`gemini-5h`、`gemini-weekly`）与 `Claude and GPT models`（`3p-5h`、`3p-weekly`）；`window` 为 `5h` 或 `weekly`。两点值得留存：分组是**按组**而非按模型，且 `3p-*` 同时覆盖 Claude 与 GPT——`modelFamilyOf` 的任何前缀规则都无法复现该分组，故分组原样透传而非重新推导。它与 `fetchAvailableModels` 使用同一 bootstrap User-Agent 即返回 200，无需新增伪装。`dsh-agy` 以两种刻意不同的形状各存一份。`cachedLimits` 是**展示**缓存：按分组，由 `session.refreshLimits` 写入（经 `account.limits` RPC 暴露），对任意账号数都安全——包括调度刷新会跳过的单账号。`cachedQuota` 是**调度**缓存：按模型族（google/anthropic/openai），且周窗口同样会写入其中，因为 `rankPoolCandidates` 会把实测 `remainingFraction <= 0` 或 `weeklyFraction <= 0` 变成 `blockedUntil`——周额度耗尽的账号必须被轮换掉，而不是靠一次失败的请求才发现。因此两条路径都会读取本端点。真正承重的分离是**方向**：`refreshLimits` 只写 `cachedLimits`，绝不触碰 `cachedQuota`，从而保证一次展示更新永远不会封锁账号。
- **隐式缓存上报（实测确认）**：`usageMetadata.cachedContentTokenCount` 并非总是出现——只有缓存已预热且前缀足够大时才上报（gemini 系 ~16k+ 前缀、约第 3 个请求起命中；claude 系预热更快、可第 2 个请求即命中且命中率 ~99%）。单轮/小前缀请求一律缺失该字段，不代表模型不支持缓存。实测脚本 `scripts/probe-cache-context.mts`（三模型均复现：gemini-3.7-flash-tiered / gemini-3-flash-agent / claude-opus-4-6-thinking）。
- **缓存键 = 前缀内容，与 sessionId 无关（实测确认）**：`scripts/probe-cache-loss.mts` 用与先前 probe 逐字节相同的 20.5k system 前缀 + 全新 sessionId，第一轮即命中 20447 tokens——缓存按前缀哈希跨 session 共享。DSH 新对话首轮 0% 的真实原因是 system 前缀 ~13.5k < 16k 阈值（从未被缓存）且各对话历史不同，不是 sessionId 隔离。
- **缓存写入异步、滞后约 2 轮、按块批量（实测确认，命中率上限的根因）**：请求体逐字节前缀完全一致（append-only 构造）时，`cached` 仍每轮少于上一轮完整 prompt——命中前缀以"上一轮新增块"为单位跳升（实测每次恰好 +4086 = 一个填充块），写入滞后约 2 轮；稳态每轮未命中 ≈ 1.5-2× 每轮新增 → 命中率上限 ~88-92%。对比 DeepSeek 的即时完整写入（每轮未命中 ≈ 仅新增 → ~99%），这是 agy 命中率到不了 99% 的根因；上游行为，不可控。
- **generationConfig.maxOutputTokens 上限按模型族区分（实测）**：本通道下 Claude 族拒绝大于 **64000** 的值（64000 → 200，64001 → 400 `INVALID_ARGUMENT: Request contains an invalid argument`；在 `claude-opus-4-6-thinking` / `claude-sonnet-4-6` 上确定性复现，带或不带完整 87 工具载荷皆然），而同一端点下 Gemini 族接受 **65536**。**不要**用 Anthropic 公开 API 的限制来推导 Claude 这个数值：agy 背后可能是自部署或另有门槛的 Claude 部署，其容量与校验规则自成一套，唯一权威是本通道的实际响应。由于 `catalog.ts` 的 `maxOutputTokens` 会成为 harness 注入的 `defaultMaxTokens`，该值超限会让**每一个** Claude 请求失败（即 `session-9b7d1885` 的 400）；`translate.ts` 的 `AGY_CLAUDE_MAX_OUTPUT_TOKENS` 作为第二道防线兜底显式 `maxTokens` 与动态发现的 Claude id。
- **两种 400 文案可区分「字段名错」与「字段值错」（实测；先读文案再二分）**：无法识别的 `generationConfig` 键会被**点名**——`Invalid JSON payload received. Unknown name "maxTokens" at 'request.generation_config'`；而键名正确但值超范围只返回泛化的 `Request contains an invalid argument.`（`INVALID_ARGUMENT`）。故字段名不匹配绝不会伪装成值域问题：`session-9b7d1885` 报的是泛化文案，说明字段名正确（`translate.ts` 把 DSH 的 `options.maxTokens` 映射为 `generationConfig.maxOutputTokens`），只有 65536 这个值超过了 Claude 的天花板。
- 错误分类输入：HTTP 状态 + `Retry-After` / resetTime / 错误 JSON 形状 → runtime/classify。通用 400 归为 `request-error`（永久性——重试只是重发同一份坏 payload，不做轮换）；仅容量类 400（上下文溢出 / 模型不可用）为 transient。

## 6. 模型集

- 对照目录：OmniRoute `AGY_PUBLIC_MODELS`（从 live endpoint pin 的快照：gemini-3.6-flash-high/medium、Claude 系列、GPT 系列；含 contextLength/maxOutputTokens/supportsReasoning/supportsVision/toolCalling）。
- 别名映射参考 OmniRoute `antigravityModelAliases.ts`（仅当 fixture 实测发现 id 差异时引入）。