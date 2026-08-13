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
- Host Adapter 不计算分数，只管理舞台窗口、显示器锚定、生命周期、崩溃隔离和本地持久化。
- Runtime Core 不依赖 Electron 和 DOM，可通过 Node 单元测试验证全部状态转换。
- Stage 只实现通用反馈、计时、暂停、结算和输入路由。
- Task Module 只通过 `Task Contract v1` 接入；不允许直接操作 Electron、文件系统或任意 IPC。

## Runtime 状态机

```text
idle → opening → ready → running ⇄ paused → settling → ready
  ↑                         │                     │
  └──────── closing ←───────┴─────────────────────┘
```

非法状态转换必须立即拒绝，任务结果中的 `taskId` 与 `seed` 必须匹配当前会话。会话随机性来自显式 seed，确保问题可复现、视觉回归可固定。

## 舞台窗口合同

- 默认内容区目标为 `640 × 360`，即 16:9，接近 1920×1080 屏幕面积的九分之一；打包 EXE 在部分 Windows DPI 组合下允许每轴最多 `+2` 逻辑像素的系统边框舍入。
- 可在小屏幕上缩至 `320 × 180`，始终限制在当前显示器 work area 内。
- 优先出现在宠物上方；空间不足时出现在宠物下方；宠物移动时重新锚定。
- 透明、无边框、不进入任务栏、不可全屏；关闭舞台不关闭宠物和 Agent。
- Renderer 采用 sandbox、context isolation、无 Node，preload 只暴露白名单消息。
- 舞台崩溃由 Host Adapter 记录并关闭该舞台，不影响宠物宿主。

## Task Contract v1

任务清单必须声明：

- `apiVersion: 1`
- 固定任务 id、短标题、10–120 秒时长
- `supportsSeed: true`
- 独立的 `taskVersion / assetVersion / difficultyPolicyVersion / scoreVersion`
- 只接受 `primary / secondary / pause / resume` 四类通用输入
- 统一输出原始试次、计划/实际呈现时间、输入时间、反应时、命中/遗漏/虚报、娱乐分数和宠物事件
- 统一携带失焦、暂停、掉帧、长帧和成绩有效性标记

V1 注册三个模块：`stage-exerciser`（基础设施验收）、`cargo-signal`（Go/No-Go）和 `pack-refresh`（持续更新）。正式游戏只能在 Stage Exerciser 完成 100 次开关、30 分钟 soak、DPI/多显示器、崩溃隔离和固定 seed 验收后进入主线。

## 可重复验收

- `pnpm --filter @open-pets/desktop test:build`：编译全部主进程行为测试。
- `node --test apps/desktop/.test-dist/tests/brainpet-*.test.js`：状态机、逻辑时钟、质量监测、确定性、任务合同、存储和任务指标。
- `pnpm --filter @open-pets/desktop test:brainpet-electron`：从真实宠物按钮打开舞台，验证失焦暂停/恢复、640×360、Stage Exerciser 和 renderer 崩溃隔离。
- `pnpm --filter @open-pets/desktop test:brainpet-physical-inventory`：只读盘点当前 Windows、显示器/DPI、便携包哈希与签名，并在 `output/physical-acceptance` 写入时间戳回执。
- `powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/brainpet-physical-acceptance.ps1 -RunInteractive`：由复核人执行双屏边缘、混合 DPI、真实锁屏、真实 Agent 完成、参数负责人批准、新手理解和独立动态视觉检查；脚本不会自动锁屏或改显示设置，只有全部物理与内容检查均通过才出具 `passed`。
- `pnpm --filter @open-pets/desktop test:brainpet-stress`：真实 Electron 窗口连续开启、开始 session、关闭 100 次。
- `pnpm --filter @open-pets/desktop test:brainpet-rollback`：关闭 feature flag 后，宠物热点与舞台均不存在。
- `pnpm --filter @open-pets/desktop test:brainpet-soak`：真实 Electron 舞台持续 30 分钟，反复 session，并通过 CDP 采样 renderer JS heap。
- `pnpm --filter @open-pets/desktop package:brainpet:portable`：保留 OpenPets 源码身份和打包合同，同时产出 BrainPet 品牌的 portable 私测 EXE；正式分发前仍需代码签名。

## 渲染决策

V1 使用 Electron sandbox renderer + DOM/CSS 像素舞台，不引入 PixiJS。当前两款任务只需要少量离散 sprite、层、反馈动画和 HUD；DOM/CSS 版本的生产构建约 24.55 kB JavaScript、10.96 kB CSS，透明窗口实测 640×360 下可由统一 `requestAnimationFrame` 监测有效帧节奏。若后续任务需要大量 sprite、camera 或粒子，或无法维持最低 30 FPS 有效节奏，再以同一 Task Contract 替换 Stage renderer，不改变 Host、Runtime 或持久化主流程。

原 PRD 设想的 Canvas/PixiJS 双实现 spike 在 M3 被生产舞台测量替代：100 次真实窗口生命周期、30 分钟 soak、便携包内 178 ms 暖启动和动态视觉检查已经覆盖 V1 的决策标准。该调整避免为一次比较引入不进入产品的运行依赖；详细状态以 PRD 9.7 为准。

这不是把网页卡片搬到桌面：用户版本没有浏览器导航、默认 HTML 控件或任意网络能力；窗口、沙箱和生命周期均由 Host 管理，UI 只是 Stage 的渲染实现。

便携私测包使用 `scripts/brainpet-package-portable.mjs` 自动复用工作区已安装的 Electron，避免重复网络下载。该 unsigned 私测产物关闭 EXE 资源编辑；正式分发仍需恢复发布元数据、代码签名和发布证书流程。
