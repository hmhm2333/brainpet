# BrainPet Release 基础设施收工计划

> 状态：实施中。RC-0～RC-5 已通过对应退出门；RC-6 已进入真实跨平台 CI 整改，首轮公开候选尚未全绿，因此不能标完成。2026-08-16 经产品所有者确认，发行路线修订为全平台未签名直装，不进商店且不注册平台发行者。本文定义从当前实现收敛到可发行版本的工作，
> 不代表相关能力已经完成，也不命名为新的产品里程碑。当前冻结新游戏、积分、
> 天梯、商业化和未经验证的新 Agent，直到本文全部退出门通过。

当前执行回执：

| 工作包 | 状态 | 本地证据 |
| --- | --- | --- |
| RC-0 | 已通过 | `d80f01b`；AdapterRegistry、证据回执、runtime capability snapshot 与生成矩阵一致 |
| RC-1～RC-2 | 已通过 | `80dc0a3`、`36083ce`；Audit A 整改与独立复审在 `a23270e`、`6cf53bd` 通过 |
| RC-3～RC-4 | 已通过 | `6464fe3`、`b8d87fa`；Audit B 整改与独立复审在 `73ffb47`、`9e6a691` 通过 |
| RC-5 | 已通过 | `f9802a9`；Windows x64 native-only 包、一次点击 Codex、single-instance、冷唤醒恢复与真实 packaged UI smoke 通过 |
| RC-6 | 进行中 | 默认 package 自动 validator、真实 installer lifecycle、未签名直装合同、可信 provenance、候选→physical/performance intake→finalize 聚合回执已完成本地门；远端 CI 已验证 source contract 与六目标 native helper，并暴露 macOS 未签名封装及四格式生命周期问题，正在逐项 fail-closed 整改；六目标/四格式、正式性能门和 Stable 实机回执未通过前不标完成 |
| RC-7 | 进行中 | 正式性能 runner、公开 NSIS 同字节候选准备、原始证据重算、跨会话租约和 release 聚合已实现；30 分钟/24 小时正式证据及最终独立审核未通过前不标完成 |

## 1. 最终目标

本轮不是推翻 OpenPets，也不是继续叠加 A/B/C 原型，而是在现有实现上做有界
微重构，把已经验证的链路收敛成一个可安装、可升级、可卸载、可诊断、可跨
Agent 扩展的桌面产品。

Release 完成后，普通用户只需要：

1. 下载对应系统的 BrainPet 安装包；
2. 完成一次安装，首次启动自动检测本机支持的 Agent；
3. 保留默认勾选并点击“连接”；需要厂商信任确认时只做一次明确引导；
4. 以后打开 Agent 即可自动唤醒或连接 BrainPet，无需终端、npm、Node、Rust、
   环境变量或手工复制文件；
5. 从宠物直接进入训练，Agent 状态和游戏互不阻塞；
6. 可以从系统卸载入口完整回退，不破坏 Agent 配置和原生宠物。

完成口径不是“开发模式能跑”，而是明确标注未签名的安装包中的真实 runtime、内置 helper、
默认 discovery、安装/升级/卸载和至少一条真实 Agent 生命周期全部通过。

## 2. 设计原则

### 2.1 微重构，不做大爆炸重写

保留：

- OpenPets 已验证的桌宠窗口、状态持久化、日志、本地 IPC 和安全边界；
- BrainPet 透明舞台、任务 runtime、Host 端计时与判分权威；
- Codex Bridge、Claude Code、OpenCode 已验证的 lifecycle mapper；
- BrainPet 独立产品身份、数据目录、安装标记和发行矩阵；
- 已通过的像素视觉与交互合同。

收敛：

- 每个事实只保留一个权威来源；
- 每个自动 Agent 事件只走一条 lifecycle 通道；
- 每个 Adapter 必须明确目标产品，不再猜测宿主；
- 可选 OpenPets 服务只在真正使用时加载；
- 训练入口先作为 BrainPet 内建 feature，不用空壳插件制造伪扩展性。

延后：

- 没有真实 provider action API 的 Action Broker 和授权操作 UI；
- 第三方训练插件 API；
- 只靠窗口、日志或进程猜测状态的弱适配器；
- 云账户、天梯、付费和内容商店。

### 2.2 Installed-first

所有设计首先回答“未签名直装包里的新用户能否看懂风险提示并成功安装”，再考虑开发模式便利性。
workspace 路径、全局 Node、开发环境变量或人工缓存都不能成为 release 依赖。

### 2.5 未签名直装发行合同

- Windows、macOS、Linux 均从 GitHub Release 直接下载，不进入应用商店；
- 不申请 Apple Developer、Microsoft 代码签名证书或其他平台发行者注册；
- Windows 与 macOS 安装包必须明确标注 `Unsigned`，不得声称已获平台信任；
- 用户必须看见系统安全警告并主动确认后才能继续，产品文档提供系统原生确认路径；
- CI 使用 GitHub OIDC 的 Sigstore keyless provenance 绑定仓库、workflow、提交和 SHA-256；这证明来源与完整性，不等同于 Authenticode、Developer ID 或 notarization；
- `publicReleaseReady=true` 仅表示“可诚实发布的未签名直装候选”完成全部自动门和 Stable 实机验收，不表示操作系统信任发布者。

### 2.6 分支与发布拓扑

- 远端公开发布只认 `main`，GitHub Actions 候选与最终 Release 都必须绑定 `main` 的精确 commit；
- 基础设施与游戏任务在本地独立开发分支演进，互不要求彼此全量合并；
- 只有通过对应测试、审核且属于生产闭包的提交才择取进入 `main`，不得把开发分支的临时产物、私测证据或无关历史整支并入；
- 游戏分支不会因为基础设施发布而公开；确需远端协作时另行授权并明确可见性，不改变 `main` 是唯一发行主线。

### 2.3 能力诚实

生命周期观察、任务跳转、权限响应、消息、语音分别声明。没有公开双向 API 的
Agent 只显示状态，不提供无法可靠执行的按钮。

### 2.4 轻量是架构指标

轻量不只看 renderer heap。进程数、工作集、CPU、启动时间、窗口数量、冷唤醒、
游戏关闭后的回收和长时间 idle 都进入发行门禁。

## 3. 目标架构

```text
Electron main — 唯一 Composition Root
├─ HostCore（始终可用，最小常驻）
│  ├─ product identity / state / logging
│  ├─ default pet window / motion / reaction renderer
│  ├─ local IPC / discovery / single-instance
│  └─ AgentActivityAuthority
├─ OptionalOpenPetsServices（按需加载）
│  ├─ Control Center / catalog / pet installation
│  ├─ plugin platform
│  ├─ LAN / remote control / voice
│  └─ Agent setup UI
└─ BrainPetFeature（BrainPet profile 注入）
   ├─ TrainingEntry
   ├─ StageWindowController
   ├─ SessionAuthority
   ├─ InteractionRigController
   └─ TaskRegistry

Provider Adapter
  ├─ ProviderEventMapper
  ├─ TargetProfile = brainpet
  ├─ AdapterInstaller / Uninstaller
  └─ shared profile-targeted Client
          │
          └─ AgentActivity → HostCore
```

依赖方向必须单向：

```text
composition → HostCore interfaces
composition → OptionalOpenPetsServices factories
composition → BrainPetFeature factory
adapters → shared contract + client
BrainPetFeature → HostCore ports
```

`HostCore` 不 import BrainPet；通用 OpenPets service 不反向 import BrainPet；
`lifecycle.ts` 不知道具体服务，只执行 composition 返回的 disposer 列表。

## 4. 关键技术决策

### 4.1 显式产品路由

新增单一 `TargetProfile` 合同，至少包含：

```text
product: brainpet | openpets
appId
discoveryPath
runtimeMarkerPath
updateChannel
adapterVersion
```

规则：

- BrainPet 首次引导生成的所有 Adapter 配置都显式写入 BrainPet target；
- 显式 target 不存在时 fail-open，不得静默连接另一产品；
- 通用 CLI 必须要求 `--product brainpet|openpets`，或从已验证的 BrainPet 安装标记取得 target；
- OpenPets 与 BrainPet 同时运行是必须通过的合同场景；
- Codex、Claude、OpenCode、Cursor/MCP 共享同一 target resolver，不再各自维护
  相反的 discovery 优先级。

### 4.2 生命周期唯一通道

自动 Agent 状态统一为：

```text
working | waiting | ready | blocked | idle
```

`agent.activity` 是自动生命周期唯一入口。宿主根据状态决定宠物动画、徽标和极简
反馈。Claude/OpenCode 不再为同一自动事件额外发送 `pet.react` 或 `pet.say`。

`pet.react`、`pet.say` 继续保留，但只用于用户明确调用的 MCP/CLI/插件命令，
不能充当第二套生命周期。

### 4.3 训练入口内建化

Release 版本删除当前只做 `command → bus` 的 `brainpet.training` façade：

- `TrainingEntry` 直接注册到 BrainPetFeature；
- Host 不再拥有“插件失败后偷偷 fallback”的双路径；
- 不为内建训练常驻隐藏 BrowserWindow；
- TaskRegistry 仍保持模块化，新增游戏只增加 task module；
- 等出现第二个真正独立、可卸载的训练提供者后，再从真实共性抽象插件 API。

OpenPets 通用插件平台仍保留为 Optional Service，但不因训练而在冷启动时常驻。

### 4.4 安装与状态写入

- 关闭 `install-pet` 在宿主离线时直接重建 state 的 release 路径；
- 默认安装必须通过运行中宿主的版本化 IPC；
- 若未来恢复离线安装，先抽取共享 `PetInstallCore` 与 `StateMigrationCore`；
- 状态迁移必须保留未知字段、原子写入、版本化、可备份恢复；
- Adapter 安装也使用共享原子写入器和回执，不重复实现配置备份、rename 和恢复。

### 4.5 可选服务懒加载

冷启动只装配 HostCore、BrainPetFeature 的轻量入口和本地 IPC。以下模块在用户
第一次打开或显式启用时动态加载：

- Control Center 和完整 `windows.ts` 依赖图；
- catalog、pet installer、plugin catalog/runtime；
- LAN、remote control、voice；
- Agent setup 的写配置 UI。

服务 factory 返回统一 `{ start, dispose, diagnostics }`。Composition Root 负责
选择与生命周期，服务之间只通过窄接口通信。

### 4.6 Action Broker 延后启用

保留设计文档和必要类型，但从 release runtime 与用户 UI 移除未接线 action。
出现第一个具有稳定 request id、结构化选项和公开执行 API 的 provider 后，再以
真实 provider 接通 Broker；届时才恢复对应按钮。

## 5. 小白用户安装与使用流程

### 5.1 单一安装包

每个平台发布一个普通用户可识别的产物：

- Windows：文件名明确带 `Unsigned` 的 per-user NSIS installer；
- macOS：文件名明确带 `Unsigned`、未签名且未公证的 DMG；
- Linux x64：AppImage + deb；Linux arm64 在达到真实 runner 门禁前标 Preview。

安装包内必须包含 runtime、对应架构的 native helper、Adapter 源/manifest、字体、
默认宠物与卸载信息。用户机器不需要开发工具链。

### 5.2 首次启动

首次启动只出现一个像素风极简引导：

1. 检测已安装 Agent；
2. 显示“已检测 / 可连接 / 需要一次确认 / 暂不支持”；
3. 默认勾选所有稳定支持项；
4. 一次点击完成可自动完成的配置；
5. Codex 等需要宿主信任时，打开准确位置并用一句话提示用户确认；
6. 收到第一条真实 lifecycle 后自动完成验证并关闭引导。

不得要求用户粘贴路径、运行命令、选择 discovery 或理解 Hook。

### 5.3 日常启动

- Adapter 收到第一条事件时，如果 BrainPet 未运行，使用受验证的 marker 冷唤醒；
- BrainPet 使用 single-instance，重复事件不能打开多只宠物或多个 runtime；
- 默认采用“跟随 Agent 唤醒”，避免强制系统登录自启动；用户可在设置中选择
  “始终显示宠物”；
- runtime 已运行时，事件到宠物反馈目标小于 200ms；
- Adapter 失败必须快速 no-op，不能延迟或阻塞 Agent。

### 5.4 升级与卸载

- Runtime 与 Adapter 版本有兼容区间；不兼容时提示重新连接，不静默失效；
- 安装器原位升级并保留训练进度；
- Adapter 升级后重新生成 hash/回执，需要信任时只提示一次；
- 卸载默认移除 runtime 和 BrainPet Adapter，但保留用户训练数据选项；
- 不删除或修改 Agent 原生宠物资源；回退后原生宠物可直接重新显示。

## 6. Agent 与平台支持策略

### 6.1 Adapter 稳定等级

| 等级 | 条件 | 产品表达 |
| --- | --- | --- |
| Stable | 公开事件接口、真实安装 E2E、故障不阻塞 Agent | 默认自动连接 |
| Beta | 公开接口和合同测试通过，缺少一个真实平台回执 | 引导中可选 |
| Experimental | 依赖非稳定接口、日志或窗口推断 | 默认不展示 |
| Unsupported | 无安全稳定事件接口 | 明确不支持 |

首个 Release 的稳定目标：

- Codex：Windows、macOS lifecycle；
- Claude Code：Windows、macOS、Linux lifecycle；
- OpenCode：Windows、macOS、Linux lifecycle；
- 通用 MCP：显式用户命令，不作为自动 lifecycle。

WorkBuddy、DeepSeek Harness 和其他 Agent 先进入 Provider Contract 探测，只有
公开 Hook/Plugin/Event API 与真实安装证据齐全后升级为 Beta/Stable。不能用
“进程正在运行”冒充完整适配。

### 6.2 Runtime 平台等级

- Stable 首发门：Windows x64、macOS arm64；
- Stable 扩展门：macOS x64、Linux x64；
- Preview：Windows arm64、Linux arm64，直到有原生 runner、安装与卸载回执；
- 六目标都必须持续通过构建、格式、架构和 contract gate，但没有真实安装回执
  的目标不得标 Stable。

## 7. 实施工作包

### RC-0：事实源与历史文档冻结

工作：

- 把旧 M5.1 轻宿主/完全 rollback 文档标为历史 ADR；
- 冻结当前 release capability、target、lifecycle 和 provider ID；
- provider matrix 改为由 AdapterRegistry 与测试回执生成；
- 删除文档中与当前实现冲突的“已完成”声明。

退出门：文档、机器合同、runtime capability snapshot 一致；修改任一枚举会触发
合同测试失败。

### RC-1：产品路由与安装数据安全

工作：

- 实现显式 TargetProfile；
- 统一所有 Adapter/client 的 discovery resolver；
- BrainPet Agent setup 写入精确 target；
- 禁用离线 direct state writer；
- 增加双宿主和旧状态迁移 fixture。

退出门：OpenPets/BrainPet 同时运行时，三个 Adapter 都只进入指定产品；宿主
离线安装不会写错目录或丢字段。

### RC-2：Lifecycle 与 Adapter Core 收敛

工作：

- 自动事件只发送 `agent.activity`；
- 建立 `AdapterDescriptor + EventMapper + InstallerPlan + TargetProfile` 最小接口；
- Codex Node/Rust、Claude、OpenCode 使用同一 conformance fixture；
- 从 schema 生成或校验 TS/JS/Rust 的状态、路径、超时和版本常量。

退出门：每个 provider 的同一事件只产生一次宿主状态更新；失败在 deadline 内
no-op；隐私 rejected fields 无法进入协议。

### RC-3：Composition 与性能微重构

工作：

- 建立真正的 HostCore/OptionalServices/BrainPetFeature factories；
- lifecycle 只管理 disposer；
- Control Center、插件、LAN、remote、voice 延迟加载；
- 移除训练 façade 和隐藏插件 renderer；
- 保证 OpenPets profile 原有能力和行为不退化。

退出门：依赖方向测试通过；冷启动没有 Control Center/插件 renderer；打开对应
功能后才出现服务，关闭后可回收。

### RC-4：BrainPet Host 内聚化

工作：

- 从现有 `brainpet/host.ts` 机械拆出 `TrainingEntry`、`StageWindowController`、
  `SessionAuthority`、`InteractionRigController`；
- 保持 Host 端判分、时间和 session ownership 不变；
- 每次只移动一个状态所有者，旧测试先行，禁止同期改游戏参数。

退出门：各控制器可独立测试与 dispose；Host 聚合层不包含任务规则和大段几何
实现；游戏体验与当前基线视觉截图一致。

### RC-5：小白安装、升级与冷唤醒

工作：

- 安装包内置各目标 native helper，不依赖 Node fallback；
- 实现一次点击 Agent 检测与连接；
- 原子配置备份、升级、卸载和 receipt；
- 完成 single-instance、跟随 Agent 冷唤醒、损坏 marker 恢复；
- 更新源、appId、数据目录和 Adapter 目标全部绑定 BrainPet product profile。

退出门：干净虚拟机上从下载到第一条宠物状态无需终端；升级保留状态；卸载后
Agent 正常运行且无残留 Hook 错误。

### RC-6：真实包与跨平台发行门

工作：

- package 命令自动调用 validator；
- 使用包内 client/helper 和默认 discovery 跑 packaged E2E；
- 真实验证 NSIS、DMG、AppImage、deb 的安装/启动/升级/卸载；
- 六目标均以 fail-closed 探针验证平台签名按政策缺席，公开 runtime 使用严格 allowlist，Bridge 签名 manifest 覆盖 exact file/directory tree；
- release receipt 聚合 runtime、installer、helper、Adapter、正式性能回执，以及绑定候选 challenge、受保护 reviewer 身份并经 Sigstore OIDC 封存的人工物理回执；finalize 必须从原始候选闭包重算 package receipt、候选聚合回执和候选 Sigstore bundle 的 SHA-256，并逐项比对两份性能回执，不能只检查两个 profile 彼此一致。

退出门：任何缺失项都不能写 `publicReleaseReady=true`；Stable 平台必须有真实
安装回执，回执须绑定候选 run、回执 hash、一次性 challenge 和实际 artifact hash，证明系统警告出现且用户主动确认；
intake 必须经过 protected Environment 的非触发者 reviewer，审批评论须绑定候选 run/receipt/challenge
和精确 receipts payload digest；机器校验当前 run 的 GitHub approval history，禁止 rerun，并为回执闭包
签发 OIDC provenance，不以任意 JSON、自报 CI、自审、dry-run 或伪造二进制代替。

### RC-7：Release Candidate 验收

工作：

- 真实 Codex/Claude/OpenCode 任务连续运行；
- 24 小时 idle、30 分钟游戏 soak、崩溃恢复、睡眠唤醒、多显示器和 DPI；
- 正式性能 runner 只接受成功公开 workflow 的 Windows x64 NSIS：下载 package/aggregate receipt 与 Sigstore bundle，对候选回执、package receipt 和 NSIS 逐项执行 `cosign verify-blob` 并绑定精确 repository/workflow/trigger/commit/subject，安全解包后按完整 runtime tree 复验，并在两条长测前后绑定同一 run、attempt、installer、executable、app.asar 和 runtime-tree digest；禁止本机重打 private-test 后冒充公开候选；
- Windows 正式 runner 以 suspended 创建、精确 lease 绑定和禁止 breakaway 的 Job Object 承载每个命令；只有完整 Job 进程树归零才可发布 completion 或释放 lease；
- 安装说明、隐私政策、支持矩阵、诊断导出和回退说明最终校验；
- 修复所有 P0/P1，P2 必须有明确延期 ADR。

退出门：满足第 11 节 Definition of Done，生成不可覆盖、由证据摘要与 Sigstore provenance 封存的 RC receipt 后才允许发布。

## 8. 性能预算

以 Windows x64 和 macOS arm64 参考机的进程级指标为准：

| 指标 | Release 门 | 说明 |
| --- | --- | --- |
| 冷启动到宠物可用 | p95 ≤ 1.0s | 当前约 639ms，不允许退化 |
| 已运行事件反馈 | p95 ≤ 200ms | Adapter 到可见状态 |
| 冷唤醒到反馈 | p95 ≤ 1.5s | Agent 首次事件启动 runtime |
| 冷 idle 总工作集 | ≤ 400MiB，目标 300MiB | 软件合成整改后的单次短测约 356.6MiB；正式门待跑 |
| 游戏中总工作集 | ≤ 650MiB | 软件合成整改后的单次短测约 624.8MiB；正式门待跑 |
| 热 idle 相对冷 idle | +100MiB 内 | 单次短测约 +81.4MiB；正式门待跑 |
| idle CPU | 5 分钟均值 < 1% | 无窗口移动/动画风暴 |
| 交互帧率 | p95 ≥ 50fps，最低 30fps | 暂停/拖动单独计 |
| 游戏关闭 | renderer 5s 内退出 | 音频 utility 可识别且有界 |
| 30 分钟 soak | 工作集增长 < 64MiB | 同时检查句柄和进程数 |

如果 ≤400MiB 暂时无法达到，必须给出按进程角色拆分的证据和明确降级声明，
不能只提高阈值使测试通过。

Windows 参考机的整改保持 400/650MiB 阈值不变：BrainPet 仅加载打包内本地 surface，
保留 renderer sandbox，并使用 Electron 软件合成；不再把 GPU service 移入未沙箱 browser 主进程，
Chromium 独立 GPU/crash 边界仍保留。OpenPets 不采用该策略，继续使用 Electron 默认硬件加速路径。
该取舍必须由真实 renderer crash、全流程 smoke 与长时门共同复核。

## 9. 测试体系

### 9.1 纯逻辑与单元测试

- TargetProfile、capability、lifecycle reducer、session authority；
- Adapter event mapping、deadline、fail-open；
- state migration、marker、single-instance、安装 receipt；
- stage geometry、interaction rig、计时与判分；
- service start/dispose 与重复调用幂等。

### 9.2 合同测试

- AgentActivity schema 与隐私 rejected fields；
- AdapterDescriptor/provider ID/capability matrix；
- distribution identity、更新源、版本和六目标矩阵；
- TS/Node/Rust conformance fixture；
- OpenPets 与 BrainPet 双宿主精确路由；
- OpenPets profile 行为不变。

### 9.3 组件与集成测试

- HostCore + fake Adapter 的完整 lifecycle；
- Optional Service 未调用不加载，调用后正确 dispose；
- BrainPetFeature 不依赖 plugin renderer；
- Claude/OpenCode 高频事件严格有序；
- Codex Hook 2.6s 内 fail-open；
- 多 Agent 并发聚合不互相覆盖。

### 9.4 Electron 测试

- 正常、rollback、首次引导、损坏配置恢复；
- 宠物、状态、训练入口、透明舞台、拖动和关闭；
- 舞台 renderer crash 不影响宠物 host；
- Control Center/插件/LAN/voice 的懒加载进程快照；
- 冷 idle、游戏中、热 idle 和长时间 soak 的真实进程指标。

### 9.5 Packaged E2E

必须使用安装包内组件，不得通过 workspace import：

- 默认安装路径与默认 discovery；
- 包内 native helper `--self-test`；
- 双宿主并存；
- Adapter 安装、真实 lifecycle、升级、卸载；
- 无 Node/npm/Rust 的干净系统；
- 路径含空格、非 ASCII 用户名、普通用户权限；
- 离线、慢启动、陈旧 marker、损坏 discovery 和 endpoint 拥塞。

### 9.6 平台与物理验收

- Windows x64/arm64；
- macOS Intel/Apple Silicon；
- Linux x64/arm64；
- 多屏、125%/150% DPI、睡眠恢复；
- 真实 Codex/Claude/OpenCode 安装、操作系统未签名警告与用户确认界面；
- 安装、升级、卸载和原生宠物恢复录制回执。

## 10. 独立 SubAgent 审核制度

每次审核使用不继承本轮设计讨论的独立 SubAgent，只提供仓库路径、当前 commit、
验收合同和只读权限。审核者不得修改代码；主 Agent 不以“测试通过”替代审查。

### Audit A：P0 与目标架构审核

时点：RC-1、RC-2 完成后。

范围：双宿主路由、安装数据安全、协议单一事实源、自动事件唯一通道、隐私。

退出门：无 P0；P1 必须修复或有用户批准的 ADR。

### Audit B：内聚、耦合与性能审核

时点：RC-3、RC-4 完成后。

范围：依赖方向、composition root、God Object、隐藏 renderer、服务懒加载、
dispose、进程与内存证据。

退出门：无反向 product dependency；无训练 façade；性能预算通过；OpenPets
profile 回归不变。

### Audit C：发行与小白体验审核

时点：RC-5、RC-6 完成后，RC 候选构建之前。

范围：干净机安装、Adapter 检测/信任、冷唤醒、升级/卸载、未签名策略、Sigstore、系统警告用户确认、默认
discovery、支持等级和文档真实性。

退出门：所有 P0/P1 清零；审核者确认测试使用真实包而非 workspace 替身。

### 审核报告格式

每条 finding 必须包含：

- P0/P1/P2；
- 文件与精确行号；
- 触发条件与用户影响；
- 已验证事实 / 静态推断 / 未验证项；
- 最小修复；
- 回归测试；
- 修复后的复审结论。

## 11. Definition of Done

只有全部满足，基础设施才算“完整收工”：

- [ ] BrainPet/OpenPets 双宿主不会分裂 Agent 路由；
- [ ] 安装和升级不会写错产品或丢状态；
- [ ] 自动 Agent 状态只走 `agent.activity`；
- [ ] 训练不依赖 façade 插件和隐藏 renderer；
- [ ] Composition Root 单向依赖，可选服务真正懒加载；
- [ ] BrainPet Host 已按状态所有权拆分并可独立 dispose；
- [ ] Codex、Claude、OpenCode 至少在各自主力平台完成真实任务 E2E；
- [ ] 普通用户安装不需要终端和开发工具；
- [ ] Agent 首次事件可以安全冷唤醒 single-instance runtime；
- [ ] 性能预算、30 分钟 soak 和 24 小时 idle 通过；
- [ ] Stable 平台有平台签名缺席、Sigstore、系统警告用户确认、安装、升级、卸载回执；
- [ ] 默认包命令自动执行真实 package validator；
- [ ] rollback smoke、双宿主、packaged discovery 进入默认发行门；
- [ ] 三次独立 SubAgent 审核无未解决 P0/P1；
- [ ] 文档、支持矩阵、隐私声明与真实 runtime 一致；
- [ ] Git 工作树干净、commit 可追溯、release receipt 非覆盖写入且由摘要/provenance 封存。

## 12. 实施与提交策略

- 从当前分支建立 release-infrastructure 工作分支，不改写 `0dacd88`；
- RC-0～RC-7 每个工作包单独 commit，优先小 diff；
- 每次机械拆分先保持行为不变，再单独提交行为收敛；
- P0 修复与性能重构不得混在同一个 commit；
- 每个工作包提交前运行其局部 gate，合并前运行桌面全量与 release gate；
- Audit finding 和修复 receipt 纳入文档，但不提交用户配置、token、日志正文或
  私有安装材料；
- 任一阶段失败都回退该工作包，不回退已通过的游戏体验基线。

## 13. 明确不在本轮做

- 新认知游戏、关卡内容和任务参数调整；
- 天梯、账户、联网同步、支付和商业化；
- 宠物资产重做或非基础设施 UI 扩张；
- 没有公开事件接口的 Agent 强行接入；
- 未有真实 provider 的权限批准、停止、回复等双向操作；
- 第三方训练插件市场。

本轮结束后，BrainPet 应当是一个轻量、一次安装、可被多个 Agent 稳定驱动、
同时保有内建训练舞台的可发行桌面产品；后续增加游戏或 Adapter 只增加叶节点，
不再改动 HostCore、安装链和发行门禁。
