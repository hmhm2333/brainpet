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
- 只接受 `primary / secondary / pause / resume` 四类通用输入
- 统一输出 `score / correct / incorrect / missed / durationMs`

V1 注册三个模块：`stage-exerciser`（基础设施验收）、`cargo-signal`（Go/No-Go）和 `pack-refresh`（持续更新）。正式游戏只能在 Stage Exerciser 完成 100 次开关、30 分钟 soak、DPI/多显示器、崩溃隔离和固定 seed 验收后进入主线。

## 可重复验收

- `pnpm --filter @open-pets/desktop test:build`：编译全部主进程行为测试。
- `node apps/desktop/.test-dist/tests/brainpet-stage-exerciser.test.js`：100 次生命周期、两个模块交替、虚拟 30 分钟 soak、每 10 次一次异常退出。
- `pnpm --filter @open-pets/desktop test:brainpet-electron`：启动隔离 Electron 实例，从真实宠物按钮打开舞台，校验 640×360、进入 Stage Exerciser、截取实机画面，并令舞台 renderer 崩溃以确认宠物宿主仍存活。
