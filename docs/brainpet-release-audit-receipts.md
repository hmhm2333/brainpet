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
