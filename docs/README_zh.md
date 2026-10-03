# dsh-agy（中文文档）

[![CI](https://github.com/chaos-03x/dsh-agy/actions/workflows/ci.yml/badge.svg)](https://github.com/chaos-03x/dsh-agy/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-agy)](https://www.npmjs.com/package/dsh-agy)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Google Antigravity (agy) 接入：
OAuth 认证、多账号池 + 自动 429 轮换、设备指纹伪装，以及 CLI 与 Web 双管理入口。

> English: [README.md](../README.md)


## 功能

- **OAuth 登录**: 通过浏览器 OAuth 回调一键登录，支持 headless 粘贴 URL 模式与远程粘贴凭据 blob 通道。
- **双管理入口**: web 和 cli 任选其一，核心功能一致。
- **多账号池**: 加密账号存储、用量感知选号（模型族配额 + OMP 对齐排名）、限流自动轮换、冷却到真实 reset 时间、每账号设备指纹。
- **内联设置界面**: DSH 设置内的 Antigravity 分区，含四个标签页——账号（登录、激活、分组的 5 小时/每周配额窗口、测试调用、指纹与代理管理）、
  模型（逐模型可见性）、用量（累计 token 与请求统计）、凭据（导入/导出）。不再是独立页面：入口只存在于 DSH 设置之内。
- **会话头部配额徽章**: 把当前账号最紧的配额窗口（5 小时 / 每周）显示为会话头部的单个数字，
  悬停展开各窗口的剩余额度与重置时间。读取的就是设置面板同一份分组配额窗口，两处不会互相矛盾。
- **模型可见性开关**: 把单个模型从 DSH 模型选择器中隐藏。黑名单语义——只有你主动关闭的才隐藏，
  服务端后续新增的模型仍然可见。
- **用量统计**: 输入 / 输出 / 缓存读 / 缓存写 token、请求数、失败数、限流、轮换、延迟与首 token 时间，
  按账号与模型两个维度聚合。**包含不经过 DSH 的调用**（CLI、验证、测试），这是任何基于会话的统计都看不到的部分。
- **CLI**: `dsh-agy login|status|import|verify|logout`，独立于 harness 运行。

## 效果演示

DSH 设置内的 Antigravity 分区。账号邮箱与项目名已打码。

| 账号 | 模型 |
|:---:|:---:|
| ![账号](https://raw.githubusercontent.com/chaos-03x/dsh-agy/main/assets/zh_accounts.png) | ![模型](https://raw.githubusercontent.com/chaos-03x/dsh-agy/main/assets/zh_models.png) |
| **限额** —— 5 小时与每周窗口 | **用量** —— 累计、按模型、按账号 |
| ![限额](https://raw.githubusercontent.com/chaos-03x/dsh-agy/main/assets/zh_limits.png) | ![用量](https://raw.githubusercontent.com/chaos-03x/dsh-agy/main/assets/zh_usage.png) |

## 快速开始

### 路径 A：DSH Web 用户（推荐：全流程纯 Web UI，0 CLI 命令）

适用于使用 DeepSeek Harness 桌面/浏览器工作台的用户：

```sh
# 1. 向 DSH web profile 添加插件（支持 dsh 命令行，若未全局安装可用 pnpx/npx）
dsh plugin --profile web add dsh-agy
# 或：npx @deepseek-ai/dsh plugin --profile web add dsh-agy

# 2. 启动 DSH Web
dsh web

# 3. 打开 设置 → Antigravity，点击该分区内的「登录」
# 点击【Google 账号登录】，完成授权后即刻在 DSH 中直接调用 agy provider
```

该分区位于 **设置 → Antigravity**（与「通用」「模型」同级）。没有独立仪表盘页面：旧的 `/agy` 地址已废弃。


### 路径 B：无桌面 / 纯终端环境（CLI 独立使用）

适用于 Linux VPS、SSH 远程服务器或纯脚本自动化环境：

```sh
# 免全局安装即用（npx / pnpx）
npx dsh-agy login
npx dsh-agy status

# 或全局安装后使用
npm install -g dsh-agy
dsh-agy login          # 交互式 OAuth（浏览器 / --headless 粘贴 / --blob）
dsh-agy status         # 账号列表 + 每模型配额摘要
dsh-agy verify         # 逐账号 refresh + userinfo 校验
dsh-agy import <file>  # 导入 agy CLI auth.json 或凭据 blob（--blob）
dsh-agy logout         # 删除账号
```

## CLI 命令参考

| 命令 | 参数 | 说明 |
|---|---|---|
| `dsh-agy login` | `--headless` — 打印授权 URL，等待粘贴重定向 URL<br>`--blob` — 输出凭据 blob 而不保存账号<br>`--port <n>` — loopback 回调端口（默认 `51121`）<br>`--project <id>` — 绑定登录到指定项目<br>`--timeout <ms>` — 回调超时（默认 `300000`） | 交互式 Google OAuth |
| `dsh-agy status` | — | 账号列表 + 每模型配额摘要 |
| `dsh-agy import <文件...>` | `--blob` — 输入是凭据 blob<br>`--email <email>` — 指定邮箱（跳过 userinfo 校验）<br>`--overwrite` — 覆盖同邮箱的已有账号 | 导入 agy auth.json 文件或凭据 blob（多文件 / 多行粘贴 = 批量导入） |
| `dsh-agy export` | `--index <n>` — 只导出指定账号（默认全部）<br>`--out <dir>` — 每账号写一个 `dsh-agy-<index>.blob` 文件（默认输出到 stdout，每行一个 blob） | 将账号凭据导出为粘贴 blob |
| `dsh-agy verify` | `--index <n>` — 只验证指定账号（默认全部） | refresh + 健康检查 |
| `dsh-agy health` | `--index <n...>` — 只检查指定账号（默认全部启用账号）<br>`--interval <ms>` — 按间隔重复检查 | 批量健康检查（refresh + userinfo），凭据恢复有效的账号自动重新启用 |
| `dsh-agy logout` | `--index <n>` — 账号索引（默认当前 active）<br>`--email <email>` — 账号邮箱 | 删除账号 |

### 每账号代理（Per-account proxy）

每个账号可独立配置代理；凭据落盘加密，展示时脱敏为 `protocol//host:port`。

```sh
dsh-agy login --proxy socks5://user:pass@host:1080
dsh-agy import --proxy <url> file.json
dsh-agy proxy set --index 0 --proxy <url>   # 设置/更新
dsh-agy proxy clear --index 0               # 清除（回退到环境变量代理）
dsh-agy proxy test --index 0                # TCP 2s fast-fail 探测
dsh-agy proxy list                          # 脱敏列表
dsh-agy status                              # 展示 proxy 列（脱敏 host:port）
```

回退：未配置每账号代理时，请求走 `EnvHttpProxyAgent`（`HTTP_PROXY`/`HTTPS_PROXY` 且遵循 `NO_PROXY`）。每账号代理忽略 `NO_PROXY`、fail-closed（代理不可达则跳过该账号、不写冷却并清除亲和），且 loopback 目标（`localhost`/`127.0.0.1`/`::1`）始终强制直连。

设置 → Antigravity → 账号详情内有 Proxy 行 `[输入框] [保存][清除][测试]`，显示脱敏 `host:port`；读写与探测都走管理 RPC（`account.proxy` / `account.proxyTest`）。「保存」要求输入非空——清除已有代理是显式的「清除」动作，不会因误点空保存而丢失。「测试」探测的是输入框里的内容，所以未保存的代理可以先测再存；结果在提示行里显示可达/不可达，无可探测对象时按钮置灰并把原因放在悬停提示上。

工具栏「刷新」除重载账号列表与用量账本外，还会突破 5 小时/每周配额窗口的 10 分钟 TTL 缓存重新测量——这次强制探测会回报刷新了几个账号，因此点击不会毫无反馈。自动重载仍遵守 TTL，不产生上游调用。

### 路径 C：本地源码开发与调试（Link 模式）

```sh
git clone https://github.com/chaos-03x/dsh-agy.git
cd dsh-agy && pnpm install && pnpm run build
dsh plugin --profile web link .
```

要求 Node >= 20。

## 卸载

```sh
# 1. 从 profile 移除 DSH 插件
dsh plugin --profile web remove dsh-agy

# 2. 卸载 CLI
npm uninstall -g dsh-agy

# 3. 可选：删除本地账号数据（整个 agy 数据文件夹）
dsh-agy logout              # 先删除账号（或跳过）
rm -rf ~/.dsh/agy           # 账号、用量统计、模型可见性、思考预算、最近请求
# 只删除 ~/.dsh/.credentials.yaml 中的 AGY_MASTER_KEY 行——保留其他键！
# （从 ≤0.4 升级可能在 ~/.dsh 本身留下旧版文件：rm -f ~/.dsh/agy-*.json）

# 4. 可选：撤销 Google 侧授权
#    Google 账号安全设置 → 第三方访问 → 撤销 "Antigravity"
```

删除本地文件**不会**撤销 Google 侧的 token——refresh token 在过期或你在 Google 账号
安全设置中手动撤销前仍然有效。

## 其他你可能关心的事

### 思考预算（reasoning effort）

思考预算是 API 里的一个隐藏参数，用来控制模型思考的努力程度。上游给其中几个取值起了名字，这就是你在模型选择器里看到的 reasoning effort（high / medium / low）。填入预算会替换掉原本的 high / medium / low 传给模型，而不是叠加。

因此，自定义预算可以达到以下效果：

- **让低档想得更多** —— 在 `Low` 行填入较大数值。
- **让高档想得更少**（更快、更省）—— 在 `High` 行填入较小数值。
- **获得最大思考** —— 直接选 `High`，不必填值。
- **恢复该档默认** —— 清空该行。

模型会基于预算，根据问题难度自适应调整思考长短。这张表格展示了测试中，Gemini 3.8 Flash 在不同预算下，对不同难度题目的实际思考消耗（单位：token）：

| 设置 | 简单题 | 中等题 | 困难题 |
|---|---|---|---|
| Default | ~135 | ~1,100 | ~48,700 |
| Low | ~50 | 0 | ~9,000 |
| Medium | ~150 | ~870 | ~60,400 |
| High | ~165 | ~1,855 | ~63,400 |
| 填入 65535 | ~185 | ~2,130 | ~62,900 |

填入最大值（65535）与选 High 在困难题上完全相同，但可以提高简单题和中等题的思考程度（约 10–15%）。数值决定效果——同一数值填在任意一行，发出的请求完全相同。

注：困难题使用一道组合计数推导题（推导铺砖递推式并求第 40 项），中等题使用一道数论证明题（证明 n⁴+4 恒为合数），简单题使用一道两位数乘法。

### 轮换机制

用量感知选号：多账号时，按请求模型对应的后端计数器族（`gemini-*` → Google、
`claude-*` → Anthropic、`gpt-*` → OpenAI）排序——即将到期且仍有额度的账号优先
使用（"不用白不用"），接近耗尽的族会被避开，完全耗尽的族会把账号阻断到真实
reset 时间。

每个族都测量**两个**窗口，因为它们按不同节奏回满：

| 窗口 | 回满周期 | 判定耗尽 | 阻断至 |
|---|---|---|---|
| 5 小时滚动 | 每 5 小时 | 剩余低于 15% | 5 小时窗口的 reset |
| 每周 | 每 7 天 | 剩余不足 1% | **周**窗口的 reset |

两个闸门互相独立。一个族完全可能 5 小时预算还剩 90%、但周额度已经用尽——四次
5 小时回满也换不回周预算——因此周额度耗尽的账号会被轮换掉，而不是被选中后请求
失败。两个阈值刻意不同（5 小时的 15% ≈ 45 分钟余量；一周的 1% ≈ 1.7 小时）：
5 小时判断晚了的代价是最多等五小时，周判断晚了的代价是账号停摆数天。

周额度只来自 `retrieveUserQuotaSummary`——逐模型的 `fetchAvailableModels` 探测
完全没有窗口字段——且一次两个窗口都未上报的探测无法抹掉已知耗尽的读数。

429 (Too Many Requests)响应：

| 分类 | 行为 |
|---|---|
| `soft_rate_limit`（Retry-After < 3s） | 同账号立即重试，不冷却 |
| `rate_limited` | 冷却到服务端上报的 reset 时间（上限 30 分钟，无上报时 5 分钟）+ 切换到下一账号（单账号时冷却后重试同号） |
| `quota_exhausted`（"quota reached"/"individual quota"/RESOURCE_EXHAUSTED…） | 冷却到服务端上报的 reset 时间（上限 24 小时）——到点前不再尝试调用该账号 |
| `unknown` | 指数退避 |

401/403 → 账号吊销（标记需重新认证）。成功重置失败计数。

### 风险管控（环境开关）

| 环境变量 | 作用 |
|---|---|
| `DSH_AGY_DISABLE=1` | 总开关：插件不注册任何东西（provider + 设置分区 + 会话头部配额徽章 + OAuth 回调），CLI 拒绝运行。 |
| `DSH_AGY_FINGERPRINT_MODE=stable` | 每账号固定一个客户端身份——不做逐请求随机头、不再生指纹（OMP 式固定客户端姿态）。默认 `dynamic` 保持逐请求随机。 |
| `DSH_AGY_HEALTH_INTERVAL_MS=<ms>` | harness 内后台批量健康探测（按间隔 refresh + userinfo）；默认关闭。 |
| `AGY_CLIENT_ID` / `AGY_CLIENT_SECRET` | 自备 OAuth App 逃生通道：覆盖内置的公开 Antigravity 客户端凭据。 |


### 关于缓存命中：为什么达不到 DeepSeek V4 的 99%？

结论：**缓存命中策略由模型提供商（在我们的项目中，指的是 Antigravity）的缓存机制决定；agy 的机制有
两处和 DeepSeek 不同，决定了它的命中率天然比 DeepSeek 低一截。**

**第一处不同：缓存的启用门槛。** DeepSeek 的缓存默认开启没有门槛，
它的第一个请求就能命中之前缓存的系统提示。而 agy 的 gemini 系模型要求
请求消息前缀达到约 16k token 才开始缓存，而 DSH 的默认裸系统提示
（System Prompt）只有约 13k token，低于这个门槛——所以每个新对话的
前一两个请求必然是 0%，要累积消息大小 > 16k 才开始命中。

**第二处不同：缓存更新的速度。** DeepSeek 在每个请求结束时立即更新缓存，
每轮对话中只有最新那条消息没命中，命中率接近 100%。agy 的缓存更新慢半拍，
本轮新增的内容，不会在下一轮被命中——要等大约两轮后才进入缓存生效，中间这一
两轮对相同内容的请求全部算"未命中"。结果每轮都有约 1.5 到2 倍新增量的内容
无法命中。长对话的命中率会随上下文增长持续上升，理论上限由模型上下文窗口决定。

**实用建议**

- 别期待 agy 能达到 99%：差距来自上游机制，没有优化空间。
- 如果你真的有什么奇怪的数字强迫症，往 System Prompt 里塞一些自定义内容（MCP / 工具定义 / 角色扮演 ...）。

### 存储与密钥

所有 agy 数据文件统一放在一个文件夹 `~/.dsh/agy/`（`$DSH_HOME` 可整体迁移）。
从 ≤0.4 升级后，首次启动时会把 `~/.dsh/` 下的旧版文件一次性原子改名挪进去；此后
如果旧路径又出现同名文件，说明还有旧版本进程在运行——会有一次警告说明这一点。

- 账号：`~/.dsh/agy/agy-accounts.json`，AES-256-GCM 加密；主密钥在
  `~/.dsh/.credentials.yaml`（`AGY_MASTER_KEY`，0600）。`$DSH_HOME` 可整体迁移。
- 模型可见性：`~/.dsh/agy/agy-models.json`（0600）——被隐藏模型的名单，只记录你关闭掉的模型，重新打开即删除对应条目。
- 用量统计：`~/.dsh/agy/agy-stats.json`（0600）——累计计数器加一个滚动 30 天窗口。计数在文件锁下合并，
  因此多个进程（桌面端、web profile 服务、CLI）可并发记录而不会互相覆盖。
- 最近请求：`~/.dsh/agy/agy-recent.json`（0600）——最近 200 条请求与轮换记录，落盘后
  面板在重启后仍可见，也能看到其他进程的历史（外部进程的新记录 ≤30s 到达）。
- 指纹池（版本串/SDK 客户端）可通过 `~/.dsh/agy/agy-fingerprint-data.json` 覆盖——
  无需发版即可更新。
- 以上文件均不存 token、代理或 project id——只存账号 email；token 加密存在账号文件里，
  主密钥存在凭据文档里。


## ⚠️ 风险声明

本插件使用 Antigravity 桌面产品内置的 Google consumer OAuth 客户端，并在该产品
之外使用 Antigravity Cloud Code API。这可能违反 Antigravity 服务条款。
**风险自负**——账号可能被限流、降级或封禁。多账号轮换、设备指纹与
签名绕过 sentinel 默认开启，设计上用于规避上游限制；请自行评估使用方式与账号后果。


## 参考项目与借鉴内容

本项目参考了以下 MIT 许可项目的逻辑与数据：

| 来源 | 内容 |
|---|---|
| [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth)（已归档） | OAuth 流程形态、账号存储 schema 与版本化迁移、429/退避概念、指纹设计 |
| [antigravity-claude-proxy PR #170](https://github.com/badrisnarayanan/antigravity-claude-proxy/pull/170) | 设备指纹生成（经 opencode-antigravity-auth 移植） |
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | Wire 格式（envelope/头/SSE）、端点顺序、`agy` token 文件解析、粘贴凭据 blob 编解码、thoughtSignature 重放、429 分类引擎 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 插件壳、`LlmAdapter` seam、DSH 约定 |

## 开发

```sh
pnpm install
pnpm test                      # vitest，fixture 驱动，无网络
pnpm run record:fixtures       # 重新录制真实 API fixture（需真实账号）
pnpm run e2e                   # 真实账号端到端（需 AGY_REFRESH_TOKEN）
pnpm run debug:request         # 端点/头二分探测
pnpm run verify:tools          # 真实两轮工具签名验证
npm pack --dry-run             # 验证发布产物
```
