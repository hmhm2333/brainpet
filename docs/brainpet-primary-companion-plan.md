# BrainPet 主宠替代层：本轮开发计划

> 状态：M1/M2 代码完成；M3 UI 待开发，原生 helper 本机编译待具备 Rust 工具链后复核
> 日期：2026-08-14
> 适用分支：`codex/foundation`
> 目标版本：Primary Companion V0.1

## 1. 本轮目标

本轮不继续扩充游戏内容。目标是让 BrainPet 从“能被 Agent 状态驱动的训练桌宠”变成“可以作为主要 Agent 桌宠长期使用的基础设施”。完成后，用户应当能够：

1. 安装 BrainPet runtime 和对应 Agent bridge；
2. 手动收起宿主自带宠物一次；
3. 以后直接打开或使用 Agent，BrainPet 在首次 lifecycle 事件到达时自动唤醒；
4. 在同一只宠物上看到工作、等待处理、完成、失败和多任务数量；
5. 从宠物进入活动提示、回到对应 Agent、缩放、收起和开始训练；
6. 只有在宿主确实提供操作接口时，才看到停止、授权、回答、发送消息或语音等按钮。

“完全替代”在本轮的准确含义是**体验上的主要宠物**，不是修改、注入或关闭 Codex/Claude 等宿主内部的原生宠物。当前公开接口没有提供通用的原宠显示控制能力，因此首次切换仍需要用户手动执行一次宿主的“收起宠物”。BrainPet 不读取或改写宿主私有配置。

## 2. 证据边界

本计划的 Codex 功能清单来自对本机已安装 Codex `26.803.10989.0` 资源和界面文案的只读盘点，用于确定功能覆盖范围；它不是公开 SDK 合同，也不作为复制私有实现的依据。

BrainPet 只使用以下可发行接口：

- 宿主公开 lifecycle hooks、插件 API、MCP、CLI 或文档化 deep link；
- BrainPet 自己的本机 IPC 和窗口能力；
- 用户明确选择的本机安装与授权流程。

不使用私有 IPC、应用资源注入、UI 自动化、配置篡改或未文档化的宿主动作协议。宿主升级后，未声明的能力默认关闭，而不是猜测调用。

## 3. 体验合同

### 3.1 主宠结构

BrainPet 只有一个常驻主宠实例，不再为每个并发任务生成一只宠物。并发任务合并为宠物状态、数量徽标和活动列表：

```text
Agent providers
  -> lifecycle / request / completion events
  -> Provider Adapter
  -> Companion Session Store
  -> one Primary Companion window
       ├─ pet animation and status badge
       ├─ compact activity tray
       ├─ capability-gated action prompt
       └─ pet-body training hotspot -> BrainPet Stage
```

### 3.2 宠物本体与控件

- 训练入口继续是宠物身体上的像素配件，不恢复独立字母按钮。
- 单击宠物本体不直接开始训练，避免与拖动、状态提示和宿主操作冲突。
- 拖动宠物移动；右键菜单承载低频设置。
- 状态徽标只在存在活动时显示，不让宠物长期带着 Dashboard。
- 点击状态徽标展开紧贴宠物的像素活动窗格；再次点击或失焦收起。
- 等待授权、提问或失败时允许出现一条短提示；操作按钮只来自能力契约。
- 舞台仍从宠物附近向屏幕中心展开，打开训练时不改变 Agent 活动状态。

### 3.3 自动唤醒与收起

- BrainPet 已运行：bridge 直接发送事件，主宠按状态显示。
- BrainPet 未运行：bridge 读取安装标记，启动签名 runtime，等待最多 2.5 秒发现 IPC，再重发首个事件。
- runtime 使用单实例锁；同时到达的多个 hook 不会启动多份进程或多只宠物。
- 用户选择“本次收起”：当前没有新事件时保持隐藏，下一个新的 Agent 事件可以再次唤醒。
- 用户选择“暂停跟随 Agent”：持续隐藏且 bridge 不触发窗口，直到用户从托盘选择“唤醒 BrainPet”。
- 用户关闭训练舞台只关闭舞台，不关闭主宠或 Agent 连接。
- runtime 崩溃或未安装时 bridge 必须快速 no-op，不能阻塞 Agent。

## 4. Codex 原宠能力覆盖矩阵

| 能力 | Codex 已观察体验 | BrainPet 本轮处理 | 优先级/门槛 |
| --- | --- | --- | --- |
| 唤醒/收起 | Wake Pet / Tuck Away Pet | 主宠唤醒、本次收起、暂停跟随 | P0，通用 |
| 拖动/缩放 | 拖动与连续尺寸调节 | 保留拖动；提供 XS–Huge 与后续连续缩放兼容 | P0，通用 |
| 状态 | Running / Waiting / Review / Failed | 工作、等待、待查看、失败、空闲及对应动画 | P0，通用 |
| 活动数量 | 活动按钮与计数 | 宠物状态徽标显示未处理/活动数 | P0，通用 |
| 活动抽屉 | 最新/更早活动、展开、关闭 | 最多 5 条最小活动记录；不读取 prompt、transcript、cwd | P0，通用 |
| 打开任务 | 打开通知或详细任务 | provider 声明 `openTask` 后显示 | P0，能力门控 |
| 停止任务 | Stop running task | provider 声明 `stopTask` 且能确认任务身份后显示 | P1，能力门控 |
| 授权/提问 | Allow、Deny、Run once、Apply、Answer 等 | 用统一请求卡承载；按请求 schema 渲染 | P1，能力门控 |
| 快捷输入 | Floating Quick Chat / reply | provider 声明 `sendMessage` 后显示；不在 bridge 内代跑第二个 Agent | P1，能力门控 |
| 打开链接/命令审查 | Open link / Review command | 只接受宿主提供的结构化安全动作，不解析提示文本猜测 | P1，能力门控 |
| 语音 | 新建/恢复/停止语音、静音、字幕 | 不进入本轮；保留 `voice` capability 名称 | P2 |
| 详细工具活动 | Reading、Editing、Running command 等 | 默认只显示通用状态；宿主提供安全摘要时再增强 | P2 |
| 自定义宠物管理 | 选择、安装、刷新自定义宠物 | 继续复用 OpenPets 宠物格式和现有管理能力 | 既有能力 |
| 训练 | 原生 Codex 无此能力 | 宠物身体配件打开透明训练舞台 | BrainPet 差异能力 |

### P0 的提示文案

提示必须短、可本地化，并服从状态而不是逐宿主写死：

| 状态 | 主标签 | 可选副标签 | 默认操作 |
| --- | --- | --- | --- |
| `working` | 正在工作 | `N 个任务进行中` | 展开活动 |
| `waiting` | 等你处理 | provider 给出的安全请求类型 | 回到 Agent |
| `review` | 已完成，待查看 | `N 条新结果` | 打开任务 |
| `failed` | 任务遇到问题 | provider 的非敏感错误类别 | 打开任务 |
| `idle` | 不显示状态窗格 | 无 | 无 |

提示不展示用户 prompt、文件路径、命令正文、tool input/output 或 transcript。未来若允许显示任务标题，必须由用户单独开启，并由 provider 明确标记为可展示字段。

## 5. 能力契约

### 5.1 Provider 能力

每个适配器注册一个只读能力集合：

- `observeLifecycle`：工作、等待、完成、失败和空闲；
- `listActivity`：提供可显示的最小活动条目；
- `openTask`：让宿主打开指定任务；
- `stopTask`：停止明确身份的活动任务；
- `respondToRequest`：处理授权、选择题、确认或审查请求；
- `sendMessage`：向明确任务发送用户文本；
- `voice`：宿主语音会话控制；
- `detailActivity`：宿主提供安全的工具活动类别。

UI 只从当前活动条目的 capability 集合生成操作。没有 capability 就不渲染按钮，不使用灰色假按钮，也不以“复制文本去宿主”冒充集成。

### 5.2 事件与动作分离

生命周期事件保持单向、短时、可丢弃：

- bridge 可在 hook 生命周期内发送 `agent.activity`；
- runtime 保存有限的内存活动列表和未处理计数；
- 事件丢失不会阻塞 Agent，也不会导致危险动作。

需要副作用的动作走独立 Action Broker：

- 每个动作带 provider、session、request、能力名、到期时间和一次性 nonce；
- runtime 不执行任意 shell 命令；
- adapter 校验动作仍属于当前请求且未过期；
- `allow`、`deny`、`stop`、`sendMessage` 等动作必须返回结构化结果；
- action broker 不可用时，UI 自动退化为“回到 Agent”。

Codex 当前桥接只具备 `observeLifecycle`。在找到并验证公开的动作合同前，Codex 的授权、停止和快捷输入不得标为完成。

## 6. 本轮工作包与顺序

### M0：基础设施债务清零

目的：保证新能力不建立在不完整的发行基线上。

- 复核 desktop 默认测试是否覆盖全部 BrainPet 测试；
- 修正 BrainPet/OpenPets profile 的默认启用隔离；
- 验证自定义宠物 sprite 在 BrainPet CSP 下可加载；
- 为 Windows/macOS/Linux 冻结独立产品名、appId、user-data 目录和更新通道；
- 把 idle/soak 门从 renderer heap 扩展到进程工作集、窗口数和句柄数；
- 保持 `BRAINPET_ENABLED=0` 可恢复普通 OpenPets 行为。

**退出门：** 默认测试不漏项；BrainPet profile 不污染 OpenPets profile；30 分钟 idle/soak 无持续增长；回退 smoke 通过。

### M1：Provider capability 与活动模型

实现状态（2026-08-14）：完成。`agent.activity` schema v1、capability 白名单、最小请求摘要、动作描述符安全门、多 provider/session 活动汇总与兼容旧事件均已落地。

- 新增 provider capability、活动条目、请求摘要和 action descriptor 的纯 TypeScript 合同；
- 将当前 `working/waiting/ready/blocked/idle` 映射为 UI 的 `working/waiting/review/failed/idle`；
- 支持多 provider、多 session 合并，完成一个任务不能覆盖另一个活动任务；
- 活动列表设置数量、文本和过期上限；默认不持久化内容；
- 扩展本机 IPC validator、client 类型和 contract tests，保持旧 bridge 向后兼容。

**退出门：** 旧 `agent.activity` 仍可工作；未知 capability 被拒绝或忽略；过期 action 不可执行；并发与乱序测试通过。

### M2：Primary Companion 生命周期与自动唤醒

实现状态（2026-08-14）：代码完成。BrainPet/OpenPets discovery 已隔离，打包 runtime 会写安装标记，Node 开发 bridge 与 Rust helper 源码均实现自动唤醒和 2.5 秒有界重试；Electron 单实例锁继续作为并发启动收敛门。当前 Windows 机器缺少 Rust 工具链，因此原生 helper 仍需在发布构建环境运行 `cargo test` 和四目标构建，不能据此标记公开发行通过。

- 将 lifecycle controller 输出改为单一主宠 presentation；
- 新增“本次收起 / 暂停跟随 / 唤醒”状态机；
- runtime 写入版本化安装标记，包含绝对可执行文件路径、版本和发行通道；
- native helper 在 discovery 缺失时验证标记、启动 runtime、限时重试 IPC；
- Windows、macOS、Linux 使用同一状态机和各自安全路径；
- 复用 Electron single-instance lock，第二实例只唤醒已有实例；
- 记录启动耗时与失败类别，不记录用户任务内容。

**退出门：** runtime 关闭时，从首次 Agent 事件到宠物可见的 P95 小于 3 秒；20 个并发 hook 只产生一个进程和一只主宠；缺失/损坏标记快速退出；用户暂停后不自动弹出。

### M3：P0 主宠界面

- 宠物状态徽标：状态图形、活动数、未处理数；
- 像素活动窗格：最新 5 条、状态、Agent 名、相对时间；
- 等待/完成/失败短提示，反馈集中在宠物附近；
- 通用动作：展开/收起活动、关闭单条、回到 Agent（能力可用时）；
- 右键菜单：开始训练、宠物大小、暂停跟随、收起 BrainPet；
- 训练配件与状态徽标使用不同点击区，并兼容拖动；
- 继续支持 XS、Small、Medium、Large、Huge；尺寸变化后重新计算窗口 shape、热点和舞台抛掷原点；
- 键盘和屏幕阅读器标签完整，但不在桌面上显示多余说明文字。

**退出门：** 单击、拖动、训练热点和状态徽标不互相抢事件；100 次展开/收起无额外窗口；不同缩放和 DPI 下点击区与视觉一致。

### M4：P1 宿主动作壳与安全降级

- 建立统一请求类型：permission、question、review、open-link、stop、continue；
- 请求窗格只渲染 provider 返回的结构化选项；
- 动作发送期间防重复点击，成功后关闭，失败后保留并给出一行错误；
- provider 不支持时显示“回到 Agent”，不显示不可用原生按钮；
- Codex 首版先接公开可验证的能力；其余适配器按同一合同逐个实现。

**退出门：** 每个有副作用的按钮都有 provider 合同测试、过期测试、重复提交测试和失败降级测试；没有任何按钮通过任意 shell 或私有宿主 IPC 实现。

### M5：安装、适配与跨平台验证

- BrainPet runtime：Windows x64/arm64、macOS Intel/Apple Silicon、Linux x64/arm64；
- bridge 层：原生 hook 优先，MCP/CLI wrapper 为降级渠道；
- 每个 Agent 只写一个小 adapter，不复制 runtime、舞台和 UI；
- 适配状态分为：生命周期、任务跳转、请求操作、消息、语音五档，而不是简单写“已支持”；
- 首次引导说明如何收起宿主原宠，并提供可逆的恢复说明；
- 安装、升级、重新授权、暂停、卸载和 runtime 缺失都有人工回执。

**退出门：** 一次安装后至少 Codex 在新任务中可自动唤醒 BrainPet；卸载 bridge 不影响离线桌宠/训练；卸载 runtime 后 bridge no-op；各平台不要求 Node/npm。

## 7. 测试矩阵

### 自动测试

- capability 白名单、事件 validator、隐私字段拒绝；
- lifecycle 乱序、重复、并发、过期和 provider 冲突；
- 主宠收起/暂停/唤醒状态机；
- activity tray 上限、排序、未读计数与清除；
- action nonce、到期、重复提交和 provider 断开；
- install marker 路径校验、签名发行路径和启动超时；
- 单实例与 20 个并发 hook；
- 缩放、shape、热点、舞台锚点的纯几何测试；
- `BRAINPET_ENABLED=0` 回退。

### Electron/实机测试

- Windows 100%、125%、150%、双屏混合 DPI；
- macOS Intel/Apple Silicon、Retina 与多桌面；
- Linux X11/Wayland 的透明、置顶、点击穿透和窗口 shape 降级；
- 冷启动、热启动、Agent 已运行后再启动 BrainPet；
- 锁屏、休眠、Agent 崩溃、runtime 崩溃与升级；
- 活动窗格打开时训练、训练时 Agent 完成、移动宠物时投掷 trail 清理；
- 30 分钟 idle、30 分钟游戏/Agent 混合 soak。

## 8. 性能预算

| 指标 | 目标 |
| --- | --- |
| 已运行时 hook 处理 | P95 < 100ms，hook 不等待 UI 动画 |
| 冷唤醒到 IPC 可用 | P95 < 2.5s |
| 冷唤醒到宠物可见 | P95 < 3s |
| 空闲 CPU | 典型 < 1%，无持续渲染循环 |
| 空闲工作集 | 先以现有基线测量；本轮不得增长超过基线 15% |
| 常驻窗口 | 1 个主宠；活动窗格尽量同窗口，训练时额外 1 个 overlay |
| 活动内存记录 | 最多 50 条，UI 只展示最新 5 条 |

在重新测得稳定基线前，不用单一的 renderer JS heap 数值宣称“内存合格”。验收同时记录整进程树工作集、窗口数、句柄数和随时间的斜率。

## 9. 回退方案

- 总开关：`BRAINPET_ENABLED=0` 恢复普通 OpenPets 桌宠，不加载训练与主宠替代层；
- 自动唤醒开关：关闭后 helper 不启动 runtime，但已运行的 BrainPet 仍可离线使用；
- Provider 开关：可单独禁用 Codex/Claude 等连接，不影响其他适配器；
- Action Broker 开关：发生安全或兼容问题时只保留只读 lifecycle 和“回到 Agent”；
- UI 降级：活动窗格失败时仍保留宠物状态动画；
- 原生宠物恢复：用户随时可在宿主中重新选择 Wake Pet，BrainPet 不阻止共存。

## 10. 本轮完成定义

以下全部满足才称为 Primary Companion V0.1 完成：

1. M0–M3 自动门和实机门通过；
2. Codex 新任务能在 runtime 未运行时自动唤醒 BrainPet；
3. 只有一只主宠，能正确合并多任务状态和活动数；
4. 工作、等待、完成、失败四类提示可见且不泄露任务内容；
5. 活动、缩放、收起、暂停跟随、训练入口可用；
6. `openTask` 不可用时不显示假跳转按钮；
7. M4 至少完成通用壳和安全降级；Codex 动作接入是否完成按公开 API 证据单独记录；
8. Windows 私测包通过，macOS/Linux 构建与实机状态诚实标注；
9. 安装、升级、卸载和恢复宿主原宠均有文档；
10. 未经单独确认不提交、不推送、不发布。

## 11. 当前执行顺序

```text
M0 基线清债
  -> M1 capability/activity contract
  -> M2 auto-wake + primary companion state machine
  -> M3 P0 pet UI
  -> M4 action shell and provider-gated controls
  -> M5 packaging and platform receipts
```

M1 和 M2 完成前不制作活动窗格视觉；M3 完成前不继续增加游戏；没有公开宿主动作合同前不把 Codex 的 Allow、Stop、Quick Chat 或 Voice 按钮做成可点击成品。
