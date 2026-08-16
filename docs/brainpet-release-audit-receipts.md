# BrainPet Release 独立审核回执

本文记录 `brainpet-release-infrastructure-completion-plan.md` 要求的独立只读审核。
审核通过只表示对应里程碑范围内没有未关闭的阻断项，不替代后续 RC、真实打包、
跨平台或物理设备验收。

## Audit A：P0 与目标架构

| 项目 | 回执 |
| --- | --- |
| 日期 | 2026-08-15 |
| 初审基线 | `36083ce`（RC-2） |
| 初审结论 | FAIL：0 P0、7 P1、2 P2 |
| 整改提交 | `a23270e72ba0bfeeb5c48e8b5b08f56e59d8f49c` |
| 复审方式 | 独立 SubAgent，只读源码审核；未继承本轮设计讨论 |
| 复审结论 | PASS：0 P0、0 未解决 P1、0 未解决 P2 |

### 关闭项

- Pi 自动 lifecycle 不再隐式触发 `say` / `react`，只保留显式命令。
- OpenCode doctor 精确区分 BrainPet 与 OpenPets 目标配置。
- lifecycle 必填字段、版本、capability 与隐私拒绝字段由共享合同强制执行。
- OpenCode 事件队列有界、同 session 合并，并在绝对 deadline 后丢弃。
- 真实迁移入口保留嵌套未知字段；有效主文件的备份失败会中止替换。
- IPC、身份、路径、deadline 与 Rust/Node 常量由机器可读事实源生成或校验。
- adapter conformance 进入默认和 release 门，并以真实双宿主 socket 验证路由。
- Rust helper 移除未声明支持的 WorkBuddy 自动 provider。

### 验证证据

主 Agent 在整改提交前执行并通过：

- 根级 `pnpm check`，包含 desktop 全量测试与 adapter conformance；
- `pnpm brainpet:adapters:check`、合同生成检查、source validator 与 provider 检查；
- Electron 下的 app-state 真实迁移与持久化测试；
- Rust `cargo fmt --check` 与 8 个 `gnullvm` target 测试；
- `pnpm docs:build`；
- `pnpm install --offline --frozen-lockfile --ignore-scripts`；
- `git diff --check`。

独立复审另行检查了九条初审发现的源码证据，并执行生成合同、source validator、
集中 conformance、Pi、OpenCode、install-pet、Electron migration 等只读/测试检查。
复审没有用“测试通过”替代源码审核。

### 审核边界

Audit A 覆盖双宿主路由、安装数据安全、协议单一事实源、自动事件唯一通道和隐私。
Composition、Host 内聚、性能、真实安装包和跨平台发行分别由后续 Audit B、Audit C
及 RC-7 回执负责；本回执不声明 `publicReleaseReady=true`。

## Audit B：内聚、耦合与性能

| 项目 | 回执 |
| --- | --- |
| 日期 | 2026-08-16 |
| 初审基线 | `b8d87fa`（RC-4） |
| 初审结论 | FAIL：0 P0、3 P1、2 P2 |
| 整改提交 | `f59130b`、`daecac8`、`73ffb47` |
| 复审方式 | 同一独立 SubAgent，四轮只读源码审核；不以主 Agent 自报测试替代审查 |
| 最终复审结论 | PASS：0 P0、0 未解决 P1、0 未解决 P2 |

### 关闭项

- managed-service 在异步 start/dispose 竞态中停止后续 factory，并对已创建服务只 dispose 一次。
- OptionalOpenPetsServices 的异步操作在 dispose 前 drain，dispose 后拒绝新工作。
- Stage window 的 create/init/load 同步失败会回滚 runtime、rig、anchor 和窗口资源，并允许重新打开。
- HostCore 通过 no-op port 访问 LAN pet reclamp，不在冷路径静态加载 LAN 实现。
- BrainPet static-idle 的实际 renderer 行为与下一次训练恢复、OpenPets 动画隔离均由 Electron smoke 覆盖。
- 可选插件启动成为局部资源事务；service、watcher、power listener、tray、capabilities 与 event sources 失败时逆序清理并保留原始错误。
- 插件 service 清理精确绑定实例并清空匹配的全局 singleton，失败后重试不叠加资源。
- 九个 Electron power/display listener 保留稳定引用，partial start、retry 和最终 dispose 都回到 listener baseline；tray 半初始化异常也无残留。

### 验证证据

主 Agent 在最终整改提交前执行并通过：

- desktop 全量测试、TypeScript 主进程/renderer typecheck；
- source validator、composition boundary、plugin service、resource transaction；
- 可注入 plugin platform startup 的 service/source/resume/tray/ready 故障注入；
- listener partial-registration、cleanup failure、幂等 retry/final-dispose；
- BrainPet foundation、completion 与 rollback Electron smoke；
- OpenPets profile 真实 Electron isolation smoke，确认正常动画未被 BrainPet static-idle 改写；
- 冷 idle、游戏中、热 idle、stage close、cold-ready 与可见反馈性能预算。

独立复审逐项核对依赖方向、composition root、Host 拆分、隐藏 renderer、懒加载、
dispose、进程/内存证据和 OpenPets 隔离；最终确认原五项与后续三项 finding 均无回归。

### 审核边界

Audit B 只证明 RC-3/RC-4 的内聚、耦合、资源生命周期、性能预算和 OpenPets profile
退出门。安装/升级/卸载、包内 helper、未签名策略、Sigstore、系统警告用户确认、默认 packaged discovery 和真实小白
流程仍由 RC-5、RC-6、Audit C 与 RC-7 负责；本回执不声明公开发行就绪。
