# BrainPet Runtime 与舞台架构

> 状态：V1 实施基线
> 决策：先验收运行基础设施，再接入正式认知任务。

## 分层

```text
宠物训练配件
    ↓ trainingRequested
Host Adapter（Electron 主进程）
    ↓ 窄 IPC / 会话配置
Runtime Core（状态、时钟、seed、结果）
    ↓ Task Contract v1
Stage（透明小窗、输入、动画、音效、结算）
    ↓
Task Module（Go/No-Go、持续更新、后续任务）
```

- 宠物层不知道游戏规则，只发送一次训练请求。
- Codex Bridge 只把任务生命周期映射为本地 `agent.activity`，不读取或转发提示词、工具输入输出、transcript 与工作目录；Host 按 Agent/session 聚合状态，使一个任务结束不会覆盖另一个仍在运行或等待授权的任务。
- Host Adapter 独占 session 签发和结果裁决，并管理舞台窗口、互动组合几何、显示器锚定、生命周期、崩溃隔离和本地持久化；Renderer 自报的正确性、汇总分和 `new-best` 不被信任。
- Runtime Core 不依赖 Electron 和 DOM，可通过 Node 单元测试验证全部状态转换。
- Stage 只实现通用反馈、计时、暂停、结算和输入路由。
- Task Module 只通过 `Task Contract v1` 接入；不允许直接操作 Electron、文件系统或任意 IPC。

## Runtime 状态机

```text
idle → opening → ready → running ⇄ paused → settling → ready
  ↑                         │                     │
  └──────── closing ←───────┴─────────────────────┘
```

非法状态转换必须立即拒绝，开始与结算都必须匹配 Host 签发的完整 session。会话随机性来自显式 seed，确保问题可复现、视觉回归可固定；重试也只能由 Host 针对刚完成的同一任务与关卡重新签发 seed。

## 舞台窗口合同

- 默认可见游戏区目标为 `640 × 360`，即 16:9，接近 1920×1080 屏幕面积的九分之一；打包 EXE 在部分 Windows DPI 组合下允许每轴最多 `+2` 逻辑像素的系统边框舍入。
- 可在小屏幕上缩至 `320 × 180`，始终限制在当前显示器 work area 内。
- 游戏区默认从宠物朝当前显示器工作区中心的一侧展开；Host 将宠物、游戏区、反应区、投掷点和联合透明层维护为同一 `Interaction Rig` 几何快照。
- 宠物与游戏区可独立布置，但视觉上始终是一组：游戏区与宠物可见边界的最大空隙为 `32px`，超出时游戏区停在牵引边界。拖宠物时，游戏区在牵引范围内保持原位，超出范围才被带到边界。
- 超过 `6px` 才判定为拖动，以下仍按点击处理。拖动期间逻辑任务时钟暂停且当前飞行物立即隐藏；松手稳定 `150ms` 后，未完成的当前 trial 从新投掷点无计分地重新呈现，Host 将焦点交还舞台并自动恢复。
- 联合透明层覆盖宠物投掷点至游戏区所需区域；游戏区仍保持 640×360，透明扩展部分不计入可见占地。
- 透明、无边框、不进入任务栏、不可全屏；关闭舞台不关闭宠物和 Agent。
- BrainPet 默认宠物支持右键选择 `50% / 75% / 100% / 125% / 150%`，缩放沿用持久化 `petScale`、原生命中形状和同一训练热点；只缩放宠物，不改变 640×360 游戏区合同。
- Renderer 采用 sandbox、context isolation、无 Node和独立 `persist:brainpet-stage` partition；permission request 与下载一律拒绝，preload 只暴露白名单消息。
- CSP 禁止远程脚本、连接、frame 与 form；图片只允许应用自身和两种内部宠物协议。通用 scene 的坐标渲染允许内联样式，但不允许内联脚本。
- 舞台崩溃由 Host Adapter 记录并关闭该舞台，不影响宠物宿主；真实 Electron smoke 还必须验证崩溃后可重新打开、进入任务并正常关闭。

### Desktop Overlay

正式舞台默认采用桌面叠加模式：BrowserWindow 是连接宠物与 640×360 游戏区的联合透明覆盖层，游戏区由 Host 几何快照定位在覆盖层内部；根节点、全窗卡片、边框和系统标题背景均透明。宠物仍由自己的 BrowserWindow 绘制，宠物与游戏区可以分别摆放，但投掷路径、拖动暂停和边界约束仍由同一 `Interaction Rig` 管理。正式 scene 游戏运行中不绘制标题栏、关闭按钮、说明牌、累计分数、进度条或底栏，只保留当前可选择对象与必要落点；Esc 退出、P 暂停。透明像素默认通过 `setIgnoreMouseEvents(..., { forward: true })` 穿透到桌面；鼠标移入 scene target 或拖动面时，Renderer 经窄 IPC 临时恢复窗口交互。第一关可以显示一次按键提示，单次判定只在反应区显示 `+/-` 分值；结果页限制为局部两行结算牌，整块点击重试，4 秒无操作自动收起。

互动组合的纯几何与边界约束由 [`apps/desktop/src/brainpet/interaction-rig.ts`](../apps/desktop/src/brainpet/interaction-rig.ts) 持有；Host 只接受有限屏幕坐标，并通过 `rig-geometry-changed / rig-drag-start / rig-drag-end / rig-invalidated` 通知 Renderer。拖动几何事件最多约 30Hz，空闲完整性检查为 1 秒一次。默认宠物在组合存续期间拒绝插件发起的位置移动，但保留用户拖动；舞台关闭后释放位置锁。

## Task Contract v1

任务清单必须声明：

- `apiVersion: 1`
- 固定任务 id、短标题、10–120 秒时长
- `supportsSeed: true`
- 独立的 `taskVersion / assetVersion / difficultyPolicyVersion / scoreVersion`
- 可选的版本化资源声明；资源失败必须走 manifest 声明的 fallback
- 只接受 `primary / secondary / pause / resume` 四类通用输入
- 统一输出原始试次、计划/实际呈现时间、输入时间、反应时、命中/遗漏/虚报、娱乐分数和宠物事件
- 统一携带失焦、暂停、掉帧、长帧和成绩有效性标记

任务元数据由单一 registry 提供 manifest、关卡参数、可玩性和 Host 侧 trial evaluator；Renderer 另有一个只负责构造模块实例的 factory map。V1 当前注册四个模块：`stage-exerciser`（生命周期校验）、`foundation-probe`（非正式游戏的资源、scene、多目标 input 生产探针）、`cargo-signal`（Go/No-Go）和 `pack-refresh`（持续更新）。当前产品入口只将 `cargo-signal` 标记为 playable；其余模块保留用于开发回归，不进入用户随机任务池。

`cargo-signal` 是第一个真实 scene 游戏样例：Task Module 只输出归一化飞行进度，通用 Renderer 使用 Host `Interaction Rig` 中的宠物投掷点和反应区中心生成屏幕坐标抛物线；因此物体从真实宠物位置飞向补给箱。每局由 seed 生成受约束的固定 24 题（18 Go / 6 No-Go），第一个试次必为 Go，最多连续 4 个 Go 或 2 个 No-Go。抛出第一帧即开放整个 `640×360px` 游戏舞台的左键单击和空格输入并开始 RT，两者语义相同，飞行物本身不可点击；轨迹时长等于当前关卡反应窗（Level 1 为 `650ms`），物体进入反应区即截止，不存在落点停顿。物体有三类成对外形、四档弧高、三档横向弯曲与双向旋转，Go/No-Go 的视觉变体分布一致。每次抛出时 Host 还会让宠物朝反应区方向播放约 `280ms` 的短促动作。Go 按 RT 得 `40–200`，正确 No-Go 固定 `+40`，false alarm `-40`，Go miss `-20`。Host 校验签发参数和完整试次类别序列，并重新计算正确性、RT 汇总与分数；Renderer 自报汇总不能改写结果。Host 在舞台打开期间预判整个舞台的命中，避免透明穿透窗口吞掉第一次点击。场景不带装饰性尾迹，游戏中只显示对象、固定落点与数值反馈。

本地状态使用原子临时文件替换，并保留最后一个有效 `.bak`；主文件损坏时恢复备份并记录 warning，而不是静默清零。正式游戏继续扩展前，至少要求默认完整测试、Foundation Probe、100 次开关、30 分钟 soak、DPI/多显示器、崩溃恢复和固定 seed 验收全部有有效回执。

## 可重复验收

- `pnpm --filter @open-pets/desktop test`：自动发现并执行全部 `.test.js` / `.contract.js`，再重新编译主进程后执行 dist checks；不再维护会漏项的手写测试清单，也不依赖调用命令时的 cwd。
- `pnpm --filter @open-pets/desktop test:brainpet-foundation`：通过 Windows 原生窗口热点打开生产构建，加载版本化资源和通用 scene，真实点击 primary/secondary 目标，验证失焦暂停/恢复、宠物拖动锚定、游戏区拖动时宠物同位移、资源预算、renderer 崩溃后重开和进程清理。
- `pnpm --filter @open-pets/desktop test:brainpet-electron`：同一真实窗口路径下验证默认 Stage Exerciser；初次透明窗口热点必须使用系统原生点击，不能用 DOM `button.click()` 代替。
- `$env:BRAINPET_SMOKE_TASK='cargo-signal'; node apps/desktop/scripts/brainpet-electron-smoke.mjs output/playwright/brainpet-cargo-real.png`：强制打开真实补给投递任务，验证 scene、补给箱、飞行目标、桌面叠加、锚定、资源预算与崩溃重开。
- `pnpm --filter @open-pets/desktop test:brainpet-physical-inventory`：只读盘点当前 Windows、显示器/DPI、便携包哈希与签名，并在 `output/physical-acceptance` 写入时间戳回执。
- `powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/brainpet-physical-acceptance.ps1 -RunInteractive`：由复核人执行双屏边缘、混合 DPI、真实锁屏、真实 Agent 完成、参数负责人批准、新手理解和独立动态视觉检查；脚本不会自动锁屏或改显示设置，只有全部物理与内容检查均通过才出具 `passed`。
- `pnpm --filter @open-pets/desktop test:brainpet-stress`：真实 Electron 窗口连续开启、开始 session、关闭 100 次。
- `pnpm --filter @open-pets/desktop test:brainpet-rollback`：关闭 feature flag 后，宠物热点与舞台均不存在。
- `pnpm --filter @open-pets/desktop test:brainpet-soak`：真实 Electron 舞台持续 30 分钟，反复 session，并通过 CDP 采样 renderer JS heap。
- `pnpm --filter @open-pets/desktop package:brainpet:unpacked`：产出快速启动的 `dist-brainpet/private-test/win-unpacked/brainpet.exe`，这是当前 Windows 体验测试入口。
- `pnpm --filter @open-pets/desktop package:brainpet:portable`：只用于需要单文件传输的诊断场景；它每次需要自解压，不用于启动性能和日常体验验收。

## 渲染决策

V1 使用 Electron sandbox renderer + DOM/CSS 像素舞台，不引入 PixiJS。当前两款任务只需要少量离散 sprite、层和反馈动画；包含互动组合、场景/资源基础设施与首个真实玩法后的生产构建约 40 kB JavaScript、18 kB CSS，可由统一 `requestAnimationFrame` 监测可见游戏区的有效帧节奏。若后续任务需要大量 sprite、camera 或粒子，或无法维持最低 30 FPS 有效节奏，再以同一 Task Contract 替换 Stage renderer，不改变 Host、Runtime 或持久化主流程。

原 PRD 设想的 Canvas/PixiJS 双实现 spike 在 M3 被生产舞台测量替代：100 次真实窗口生命周期、30 分钟 soak、unpacked 包内约 157 ms 舞台打开和动态视觉检查已经覆盖 V1 的决策标准。该调整避免为一次比较引入不进入产品的运行依赖；详细状态以 PRD 9.7 为准。

这不是把网页卡片搬到桌面：用户版本没有浏览器导航、默认 HTML 控件或任意网络能力；窗口、沙箱和生命周期均由 Host 管理，UI 只是 Stage 的渲染实现。

当前体验测试优先使用 `scripts/brainpet-package-unpacked.mjs`。BrainPet distribution profile 默认启用 BrainPet，OpenPets profile 默认不启用；BrainPet 不自动 seed OpenPets 的三个默认插件，使用独立 user-data、`dev.brainpet.app` 身份和 `hmhm2333/brainpet` 更新源，普通 OpenPets 行为不变。2026-08-14 Interaction Rig Foundation Probe 实测：宠物 ready 590 ms、舞台打开 106 ms；空闲 4 进程 / 494 MiB working set，活动 6 进程 / 702 MiB，崩溃恢复后空闲 5 进程 / 582 MiB；宠物拖动锚定、游戏区反向带动宠物、失焦暂停与崩溃恢复均通过。

这仍不是动态第三方游戏插件或正式发布完成：新增内置任务目前还要同时登记 metadata/evaluator 与 Renderer factory；私测产物未签名，尚未建立 BrainPet 独立 NSIS 安装器、签名证书和可用 release。这些属于下一阶段扩展/发布门槛，不应被 runtime smoke 的通过掩盖。
