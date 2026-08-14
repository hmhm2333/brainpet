# BrainPet V1 验收记录

> 日期：2026-08-14
> 分支：`codex/foundation`
> 原则：基础设施门先于正式任务；实测、模拟与环境缺口分开记录。

## M1–M4 基础设施门

| PRD 9.9 条件 | 证据 | 状态 |
| --- | --- | --- |
| Stage Exerciser 经 Host 完整运行 | Windows 原生窗口热点启动 sandbox Stage；不使用 DOM `button.click()`；Electron smoke | 通过 |
| 连续 100 次打开/运行/关闭 | `BRAINPET_LIFECYCLE_CYCLES=100`，100 次真实 BrowserWindow/session 循环，181.4 秒 | 通过 |
| 30 分钟持续运行、60 FPS 与卡顿记录 | 1,800,065ms；3,506 个 renderer heap 样本；40 个 session；最大堆 2,072,960 bytes；堆增长 88,097 bytes；StageQualityMonitor 记录掉帧/长帧 | 通过 |
| 100/125/150、主副屏、四边 | 当前 DISPLAY1 为 150%；负坐标副屏、四角和三档 DPI 由 geometry 自动测试覆盖 | 单屏实测；多屏模拟通过，双屏物理待复核 |
| 单调输入时间与暂停剔除 | `performance.now()`、LogicalSessionClock；失焦 Electron smoke 与单元测试 | 通过 |
| 固定 seed 可重复 | runtime、两款 task 与 Stage Exerciser 确定性测试 | 通过 |
| renderer 异常不拖垮宿主 | Electron `Page.crash` 后宠物 target 仍存在 | 通过 |
| feature flag 完全回退 | `OPENPETS_BRAINPET_ENABLED=0` 时无热点、无 Stage | 通过 |
| 第二模块不改基础设施 | Stage Exerciser、cargo-signal、pack-refresh 通过同一 registry/contract | 通过 |
| 状态机、生命周期、结果与清理测试 | 原 42 项 BrainPet 专项测试 + 4 项 distribution/idle timing 子测试 + Electron smoke/stress | 通过；全量上游套件受 symlink 权限阻塞 |

## Runtime / Stage 合同

- Host 只接受当前 Stage sender 的窄 IPC；renderer 无 Node、任意导航或联网入口。
- Host 使用声明式、版本化计分合同从原始试次重算正确、错误、漏答、虚报、平均反应时和娱乐分数，不盲信 renderer 汇总。
- session 存储拆分 task/asset/difficulty/score 版本、原始试次、质量标记与宠物事件；最近结果有界且原子写盘。
- 失焦、隐藏、锁屏和 suspend 均暂停；暂停时长不进入任务逻辑时间。unlock/resume 恢复并重新锚定。
- Host 订阅既有 `agent:activity` 总线；只有 `success/celebrating` 被视为 Agent 完成。运行中的当前局不被关闭、暂停或重置，完成提示延迟到本局结算页，避免抢占任务输入。
- 该总线能力只覆盖已经接入 OpenPets IPC/hook/MCP 的 Agent。当前没有验证 Codex 桌面任务生命周期会自动发布这些事件；`~/.codex/pets` 只证明宠物资源兼容，不证明 Codex 状态绑定。
- Stage 提供版本化资源缓存/缺失回退，以及 scene/layer/sprite/particle/camera 最小合同。
- 通用设置包含音效、降低动画和高辨识模式；均由 Stage 自己持久化，不扩张 Host IPC。
- 开发模式提供 Stage Exerciser、固定 seed 重放、事件日志导出、输入回显和帧/暂停状态。

## M5–M7 两款任务

- `docs/task-mapping-cargo-signal.md`：Go/No-Go 映射与污染检查。
- `docs/task-mapping-pack-refresh.md`：固定容量持续更新映射与污染检查。
- 两款任务均为 45 秒、随机直达、第一关即规则测试、同一像素世界、同一输入/计时/结算合同。
- 持续更新首轮先显示初始集合，再进行新项目进入和移出判断，避免首题猜测。
- 持续更新的两个候选均不出现在更新后集合，且只有正确候选属于上一集合；新项目不来自上一集合，无法只靠当前画面对照绕过记忆。
- 相同 seed/参数可复现；正式 task module 不引用 Electron、文件系统或持久化 API。
- 当前工程参数及公式见 `docs/brainpet-v1-parameter-freeze.md`；具体阈值仍需认知任务负责人批准。

## 视觉与实机

- 目标舞台 640×360；本机 150% Windows 缩放实测内容区 640×360。修复后源码宠物可用约 618ms、舞台约 178ms；最终 unpacked 包宠物可用约 579ms、舞台约 157ms。
- 宠物移动后舞台跟随；失焦自动暂停/恢复已在源码 smoke 覆盖；按钮可点击区域 30×30。BrainPet Windows 档使用原生窗口 shape，修复透明窗口首击竞态。
- 介绍、Stage Exerciser、Go/No-Go、持续更新、结算页、unpacked 和 portable package 均有 Electron 实机截图留在本地 `output/playwright`（该目录不进入 Git）；最终视觉检查未发现文字/按钮溢出、默认 HTML 控件或像素缩放模糊。
- 正常私测入口改为 `apps/desktop/dist-electron/win-unpacked/brainpet.exe`。旧 portable 包每次首次展开约 57 秒，只保留为传输/诊断形式，不再作为体验或启动性能证据；其旧哈希也不代表本轮修复后的代码。
- 空闲 BrainPet 轻量档实测 4 个进程、约 516–548MB 工作集、304–336MB 私有内存；完整 OpenPets 默认插件档为 7 个进程、约 802MB 工作集、401MB 私有内存。轻量档减少 3 个插件 renderer，但 Electron 底座仍然明显，不宣称原生桌宠级占用。
- 空闲 6 帧不再平均摊在 5.5 秒内；首帧保持 78%，眨眼帧集中播放，修复视觉上的慢动作卡顿。
- 2026-08-14 用户在最终 unpacked 包上人工确认：宠物动画卡顿已消失，单击 `B` 可正常弹出训练舞台；该确认只放行入口与舞台基础设施，不代表两款游戏设计通过。
- 一局 45 秒 Go/No-Go 完成链路实测：35 正确、0 失误、0 漏答、3500 分、升至第 2 关；成绩质量有效，长帧诊断保留但最低 30 FPS 有效节奏未失守。
- 未使用竞品名称、角色、贴图、音效或关卡数据；视觉为原创掌机像素表达。

## 已知环境边界

- 验收机只有一个物理显示器，无法诚实声称完成双显示器物理复核；已覆盖副屏负坐标和四边几何，并保留外部双屏私测项。
- 最新只读盘点回执由 `test:brainpet-physical-inventory` 生成；Windows 11 build 26200、DISPLAY1 2560×1600、150% DPI、物理显示器数 1。回执位于本地 `output/physical-acceptance`（不进入 Git）。
- 当前私测包未做商业代码签名，Windows 会显示未知发布者；本地 Electron dist 可同时构建 unsigned `win-unpacked` 回退目录。
- 当前 Codex 直接活动绑定仍是缺口；只能验证 OpenPets Agent 总线隔离策略，不能写“已绑定 Codex”。
- OpenPets 上游部分测试依赖 Windows symlink 权限或已有断言，BrainPet 专项测试、构建、打包合同与 Electron 实机测试单独列证据，不把上游环境失败算成 BrainPet 通过。

## 外部物理复核步骤（V1 最终放行前）

当前开发机无法独立完成以下五项，不能以模拟结果代替：

1. 双显示器：在 100%/125%/150% 的实际组合中，把宠物和游戏区分别拖到两块屏幕的四个边缘；确认游戏区默认朝工作区中心展开、两端在 `32px` 牵引范围内可独立移动、超出后仍保持紧邻关系，任务栏任意边缘均不遮挡。
2. 锁屏与 Agent 并发：任务进行中按 `Win+L`，解锁后确认仍显示暂停、点击继续后时钟从原进度恢复；让 Agent 在任务中完成一次工作，确认宠物状态可变化但舞台不关闭、不重置 session、不抢占其他应用焦点。
3. 参数负责人批准：认知任务负责人核对 `docs/brainpet-v1-parameter-freeze.md` 的反应窗、Go 比例、容量、block 步长、通关阈值和污染约束。
4. 首次用户规则理解：请未看过产品说明的用户直接开始；不经过独立教程页，在第一关结束前能正确说明并执行两款任务规则。
5. 独立动态视觉评审：查看一轮 Go/No-Go 和一轮持续更新的实机录屏，逐项确认文字不溢出、像素不糊、红/蓝刺激可区分、正误反馈不闪烁、暂停/结束动作清楚，且画面没有默认 HTML 控件或诊断占位。

复核人运行 `powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/brainpet-physical-acceptance.ps1 -RunInteractive`。脚本会在 `output/physical-acceptance/<时间戳>` 生成 JSON 与 Markdown 回执，记录机器环境、显示器、DPI、便携包哈希、逐项结论和证据路径；它不会自动锁屏、修改显示设置或关闭进程。以上项目没有一份 `overallStatus: passed` 的外部回执前，状态只能是“开发验收完成，V1 物理/内容放行待复核”，不能写“全部验收通过”。

## 回退

1. 临时回退：启动前设置 `OPENPETS_BRAINPET_ENABLED=0`，宠物 HTML 不渲染训练热点，Host 不注册 BrainPet IPC/窗口。
2. 私测目录回退：关闭私测版，重新运行原 OpenPets；BrainPet 仅写用户数据目录下的 `brainpet-state.json`。
3. 代码回退：BrainPet 变更保持独立 commit，可从 `codex/foundation` 回退对应 commit，不改写保存的 upstream ref。
