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
- Host Adapter 由薄聚合层和四个可独立测试、可独立释放的控制器组成：`TrainingEntry`、`StageWindowController`、`SessionAuthority`、`InteractionRigController`。`SessionAuthority` 独占 session 签发、结果裁决和本地持久化；窗口安全与命中检测、互动组合几何和入口注册分别由对应控制器持有。Renderer 自报的正确性、汇总分和 `new-best` 不被信任。
- `StageWindowController` 把 Host 状态转换、rig 锁定、窗口创建/加固和首次加载视为一个事务；任一同步步骤失败都会销毁半成品窗口、释放 rig 并把 session authority 恢复到 idle，随后可直接重试。
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

互动组合的纯几何与边界约束由 [`apps/desktop/src/brainpet/interaction-rig.ts`](../apps/desktop/src/brainpet/interaction-rig.ts) 持有，几何状态、锚点监听与定时器由 [`apps/desktop/src/brainpet/interaction-rig-controller.ts`](../apps/desktop/src/brainpet/interaction-rig-controller.ts) 持有；Host 聚合层只接受有限屏幕坐标，并通过 `rig-geometry-changed / rig-drag-start / rig-drag-end / rig-invalidated` 通知 Renderer。拖动几何事件最多约 30Hz，空闲完整性检查为 1 秒一次。默认宠物在组合存续期间拒绝插件发起的位置移动，但保留用户拖动；舞台关闭后释放位置锁。

正常关闭舞台后，BrainPet 在原位置重建默认宠物窗口以终止旧 Renderer；当内置宠物没有 Agent、气泡、状态或托盘活动时，新窗口使用同形静态缩略图释放 8×9 spritesheet 的解码工作集。下一次训练请求或活动状态会先恢复完整动画。Electron smoke 直接读取 computed style 验证这两个状态；独立 OpenPets-profile smoke 则验证 OpenPets 的 renderer 不被替换且继续动画。该回收回调只由 BrainPet Host 注入，不改变 OpenPets profile。

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
- `pnpm --filter @open-pets/desktop test:brainpet-physical-inventory`：只读盘点当前 Windows、显示器/DPI，以及默认未签名 NSIS（若存在）的 hash/AuthentiCode 状态，并在 `output/physical-acceptance` 写入 inventory 回执；该结果不能进入公开发行门。
- `powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/brainpet-physical-acceptance.ps1 -RunInteractive -ArtifactPath <BrainPet-Unsigned-setup.exe> -SourceCommit <sha> -CandidateReceiptPath <candidate-receipt.json>`：由复核人执行系统警告确认、真实安装/发现/Agent lifecycle/升级/卸载、双屏混合 DPI、睡眠恢复、新手理解和动态视觉检查。脚本只主动打开未签名安装器，不关闭 SmartScreen、不自动睡眠、修改显示设置或停止进程；只有全部项目通过才出具绑定公开候选的 privacy-minimized schema-v5 回执。
- `node apps/desktop/scripts/brainpet-macos-physical-acceptance.mjs --artifact <BrainPet-Unsigned.dmg> --source-commit <sha> --candidate-receipt <candidate-receipt.json> --output <new-dir>`：在 Apple Silicon 物理机验证同一组合同，确认 Gatekeeper 拒绝、没有 notarization ticket，并记录用户通过“隐私与安全性”→“仍要打开”的单应用确认。
- `pnpm --filter @open-pets/desktop test:brainpet-stress`：真实 Electron 窗口连续开启、开始 session、关闭 100 次。
- `pnpm --filter @open-pets/desktop test:brainpet-rollback`：关闭 feature flag 后，宠物热点与舞台均不存在。
- `node apps/desktop/scripts/brainpet-performance-gate-runner.mjs start active-30m --candidate <prepared-manifest>`：唯一可出具 `gateProfile=active-30m / gatePassed=true` 的 Windows x64 正式命令。命令先重验由公开 CI 原始 NSIS 准备出的同字节 runtime，静置 10 秒但不启动预热，再收集 40 次全新进程的冷启动/首次 Agent 冷唤醒、20 次热反馈、21 次舞台打开、20 次 renderer 关闭和 20 个可见交互帧率窗口；要求冷启动 p95≤1.0s、热反馈 p95≤200ms、冷唤醒 p95≤1.5s、舞台打开 p95≤500ms、renderer 关闭最大≤5s、帧率 p95≥50fps 且最低≥30fps。响应性全部通过后，真实 Electron 舞台才持续至少 30 分钟并反复 session，每分钟保存根 browser PID 下全部异名后代的 PID/创建时间/角色和逐进程指标；要求至少 31 个连续样本、采样间隔不超过 70 秒、完整进程树总工作集不超过 650 MiB、私有工作集/private commit 同样不超过 650 MiB、私有工作集增长低于 64 MiB、句柄不超过 3500 且相对首样本峰值增长低于 256、进程树身份全程不变。每个样本同时以逐 PID 原始值保留总工作集和私有指标，避免为了门禁隐藏 Chromium/DLL 共享页；任一 PID 缺少 `WorkingSetPrivate` 计数器都会失败。直接设置较短 duration 只会产生 `gateProfile=probe / gatePassed=false`；缺少同等进程证据的平台明确失败。
- `node apps/desktop/scripts/brainpet-performance-gate-runner.mjs start idle-24h --candidate <prepared-manifest>`：唯一可出具 `gateProfile=idle-24h / gatePassed=true` 的 Windows x64 正式命令；冷启动后先等待启动期窗口和进程完全收敛，要求唯一 pet target、唯一 browser/renderer 和完整 PID/创建时间身份连续稳定 2 秒，随后才开始 24 小时计时。每 5 分钟采集 pet renderer heap 和同一完整进程树，要求至少 289 个样本、任一采样间隔不超过 310 秒、全程只有 pet renderer、完整进程树总工作集不超过 400 MiB、私有工作集/private commit 同样不超过 400 MiB、私有工作集增长低于 64 MiB、句柄不超过 2750 且峰值增长低于 128，并且每个采样区间的归一化 CPU 均值低于 1%。2750 是由 production-like 稳态探针峰值 2516 加约 9% 运行余量得到，增长门仍负责拒绝泄漏；正式计时前即校验基线句柄。单次 heap CDP socket/timeout 故障最多重试 3 次且每次命令限时 5 秒；WMI 进程表与私有工作集计数器在 renderer 正常退出时可能短暂错位，只对这一种精确 join 竞态最多重采样 3 次，最终样本仍记录完整 PID/创建时间并参与连续性判断。协议错误、renderer 崩溃、最终计数器缺失或累计采样空洞仍会失败。总工作集是正式预算的主门且仍在原始时间线逐 PID 保留；睡眠、长事件循环停顿、远程/本地桌面切换导致的 GPU 或 renderer 进程替换或证据空洞都会失败；该命令不把 Windows 结果冒充 macOS arm64 回执。
- 正式命令只接受干净 tracked tree，并在启动 Electron 前把当前 commit、schema-v2 package receipt 的原始 SHA-256、`brainpet.exe` 与 `resources/app.asar` 的 SHA-256 绑定为同一个候选。Electron 及所有后代完成清理之后，才以非覆盖的原子 hard-link 在 `output/performance/brainpet-<profile>-<commit>.json` 发布成功回执；失败、清理失败、重跑同一 commit 或篡改回执都不能留下新的 `gatePassed=true` 证据。
- 正式长测先用 `pnpm brainpet:performance:candidate:prepare -- --run-id <candidate-run-id> --commit <sha>` 下载成功公开 run 的 Windows x64 NSIS、package/aggregate receipt 与 Sigstore bundle；维护机须可调用已认证的 `gh`、`cosign` 3.1.3 和系统 `tar.exe`。准备链会对候选回执、package receipt 和 NSIS 逐项执行 `cosign verify-blob`，重验 repository、workflow 名称与路径、触发事件、精确 commit 和 subject bytes，再核对 run/attempt 与 bundle hash，并从 NSIS 无安装解出、逐字节复验 runtime。随后使用 `node apps/desktop/scripts/brainpet-performance-gate-runner.mjs start idle-24h --candidate <prepared-manifest>`（活动门将 profile 改为 `active-30m`）启动独立隐藏后台 worker，并用 `pnpm brainpet:idle-gate:status` 读取 run manifest、PID 创建时间、Node 可执行文件、命令身份、不可变 completion 与成功回执。正式 runner 不重打本机 `private-test`，长测前后都重验同一公开候选与三份 Sigstore subject。worker 的每个 Smoke 命令都先以 suspended 状态进入禁止 breakaway、`KILL_ON_JOB_CLOSE` 的 Windows Job Object；租约写入监督进程和 suspended 根进程的精确身份后才恢复执行，根进程退出后 Job active-process count 必须归零，否则整棵后代树被终止且本次门失败。它可脱离当前 Codex 终端继续运行；关机、重启、注销、worker 消失、PID 被复用或系统睡眠造成采样空洞仍会标为 `interrupted`/失败，必须从零重新累计完整 24 小时，不能续跑或拼接两段证据。
- 候选准备应在精确远端提交的干净维护 checkout 中先完成锁文件安装，并运行 `pnpm --filter @open-pets/desktop build` 生成同一提交的本地验证脚本；该 build 不生成或替换待验收的公开 runtime。
- `pnpm --filter @open-pets/desktop package:brainpet:unpacked`：产出快速启动的 `dist-brainpet/private-test/win-unpacked/brainpet.exe`，这是当前 Windows 体验测试入口。
- `pnpm --filter @open-pets/desktop package:brainpet:portable`：只用于需要单文件传输的诊断场景；它每次需要自解压，不用于启动性能和日常体验验收。

## 渲染决策

V1 使用 Electron sandbox renderer + DOM/CSS 像素舞台，不引入 PixiJS。当前两款任务只需要少量离散 sprite、层和反馈动画；包含互动组合、场景/资源基础设施与首个真实玩法后的生产构建约 40 kB JavaScript、18 kB CSS，可由统一 `requestAnimationFrame` 监测可见游戏区的有效帧节奏。若后续任务需要大量 sprite、camera 或粒子，或无法维持最低 30 FPS 有效节奏，再以同一 Task Contract 替换 Stage renderer，不改变 Host、Runtime 或持久化主流程。

原 PRD 设想的 Canvas/PixiJS 双实现 spike 在 M3 被生产舞台测量替代：100 次真实窗口生命周期、30 分钟 soak、unpacked 包内约 157 ms 舞台打开和动态视觉检查已经覆盖 V1 的决策标准。该调整避免为一次比较引入不进入产品的运行依赖；详细状态以 PRD 9.7 为准。

这不是把网页卡片搬到桌面：用户版本没有浏览器导航、默认 HTML 控件或任意网络能力；窗口、沙箱和生命周期均由 Host 管理，UI 只是 Stage 的渲染实现。

当前体验测试优先使用 `package:brainpet:unpacked`。BrainPet distribution profile 默认启用 BrainPet，OpenPets profile 默认不启用；BrainPet 不自动 seed OpenPets 的三个默认插件，使用独立 user-data、`dev.brainpet.app` 身份和 `hmhm2333/brainpet` 更新源，普通 OpenPets 行为不变。2026-08-16 的旧 Windows x64 `active-30m` 结果只按私有工作集判门，且冷唤醒没有证明精确 Agent session/turn 已成为用户可见状态；它不满足当前“完整进程树总工作集 + 原始指标重算 + 精确可见事件 + receipt wall-clock”合同，已明确作废。软件合成整改后的单次短测为冷 idle 总工作集约 356.6 MiB、活动约 624.8 MiB、热 idle 相对冷 idle约 +81.4 MiB，renderer crash 隔离与恢复通过；这些仅是短探针，不是正式回执。当前 commit 的 30 分钟 active、24 小时 idle 与 macOS arm64 实机门禁均仍待独立完成。

这仍不是动态第三方游戏插件或正式发布完成：新增内置任务目前还要同时登记 metadata/evaluator 与 Renderer factory；历史私测产物没有可信 CI provenance，公开未签名直装候选及其 Stable 实机回执仍待通过。这些属于下一阶段扩展/发布门槛，不应被 runtime smoke 的通过掩盖。
