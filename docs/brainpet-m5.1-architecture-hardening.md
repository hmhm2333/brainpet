# BrainPet M5.1：产品边界与发行可靠性修复

> 文档类型：历史 ADR，记录 `0dacd88` 之前的 M5.1 决策与当时回执。
> 本文中的“已实现／已完成”只描述该历史基线，不是当前 Release 完成声明。
> 当前事实源与退出门以 `brainpet-release-infrastructure-completion-plan.md`、
> `config/brainpet-*.json` 和生成的 `integrations/brainpet-provider-support.json` 为准。

## 0. 2026-08-15 实施回执

| 工作包 | 状态 | 当前证据 |
| --- | --- | --- |
| W1 Composition Root | 已实现 | OpenPets runtime 已移到动态 composition 模块；BrainPet 不加载其 LAN、远控、Control Center 和插件启动路径 |
| W2 完整回退 | 已实现 | unpackaged 与 packaged rollback smoke 均拒绝 `agent.activity`，且无训练/活动 UI、Setup 写入口或 marker 刷新 |
| W3 单一契约 | 已实现 | 两个 `config/brainpet-*.json` 被源码与发行验证器校验 |
| W4 Deadline / AppImage | 代码完成，跨平台 Rust 实编待 CI | Node/Rust 使用 2600ms 内部 deadline；非 TCP 写入有界；AppImage 持久路径测试通过 |
| W5 安装状态 | 已实现 | runtime、Bridge 人工确认、与 Bridge 版本绑定的 lifecycle 证据分别持久化；升级会清除旧任务证据 |
| W6 产物验证 | 本地发行门已实现；远端 public gate 未完成 | Windows unpacked、NSIS、portable 已生成；runtime/installer/签名回执分离；六目标 helper、四格式 lifecycle 与 GitHub OIDC/Sigstore provenance 已纳入候选工作流，仍待真实远端回执 |
| W7 本机替换 | 待用户最终确认 | 安装包已就绪；尚未运行安装器、写 Codex 插件状态或收起原生宠物 |

## 1. 目标与完成口径

M5.1 把 M5 的“发行基础设施初版”收敛为可验证、可回退的独立 BrainPet 产品。代码完成和公开发行是两个门：本地代码门必须全部通过；六平台签名、公证、真实 Agent 信任仍需各平台回执，未执行时不得写“公开发行完成”。

完成后必须满足：

- BrainPet 与 OpenPets 使用独立 composition root；BrainPet 不装配 OpenPets 插件目录、Agent 配置写入、LAN 或 remote-control 控制面。
- `BRAINPET_ENABLED=0` 同时关闭训练 Host、Agent lifecycle、`agent.activity` IPC、主宠活动 UI、首次引导和安装标记刷新。
- Codex Bridge 使用一个端到端 deadline，任何路径都给 Hook 留出退出余量。
- Windows、macOS、Linux 的 x64/arm64 helper 经过 PE、Mach-O 或 ELF 格式及架构验证；随机字节只能测试装配器，不能通过发行验证器。
- AppImage 记录原始 `APPIMAGE` 路径，退出后可由 Hook 冷唤醒。
- 安装、Bridge 确认、新任务验证、重新授权、暂停和降级进入统一状态机；自动证据和人工确认明确区分。
- Distribution identity、目标矩阵、版本和 Agent activity 字段拥有单一机器可读事实源。
- 私测与公开发行模式分离；公开模式缺少签名或公证配置时 fail closed。

### 1.1 独立审查问题的处理结果

本轮独立审查提出的回退变量、打包身份、deadline 和安装证据四类 P1 已关闭：正式回退变量统一为 `BRAINPET_ENABLED`；打包后的发行身份与更新仓库忽略环境 override；Rust 的 pipe/socket 写入受 2600ms 总预算约束；安装证据绑定 Bridge 版本并验证 marker 与真实可执行文件。公开 runtime 回执也不再自行宣称整体 release ready。跨目标 Bridge helper、Linux provenance、四格式 lifecycle 与 Stable 物理回执现由同 commit 的候选、intake、finalize 三段门控制；在真实远端与物理回执通过前仍阻断 public release。四个 P2 中，Setup 回退隔离、协议字段漂移和 CI `config/**` 触发已修复；OpenPets 服务已迁移到动态 composition 模块，产物进一步做 source-level allowlist 仍留作公开发行前的体积优化。

### 1.2 本机验证回执

- 桌面全量测试：通过。
- 发行合同、六目标 package dry-run、结构化假产物装配：通过。
- unpackaged 正常与回退 Electron smoke：通过。
- packaged Windows x64 正常与回退 smoke：通过；正常启动 845ms，舞台打开 167ms。
- Windows 私测安装器：`BrainPet-PrivateTest-3.4.0-win-x64-setup.exe`，175,806,147 bytes，SHA-256 `c8af844b8219248ac094b89811b6fb55e6dc50ae308fb561d21400218754b064`，结构与内容验证通过，`NotSigned` 符合 private-test 定义。
- 本机没有 Cargo；Rust 六目标真实编译、`--self-test`、macOS/Linux installer 与签名/公证只能由 portability CI 和对应平台完成，当前保持 pending。

## 2. 目标依赖方向

```text
distribution manifest
  ├─> openpets composition root ─> OpenPets services
  └─> brainpet composition root ─> BrainPet services
                                      ├─> companion core
                                      │     └─> provider adapters
                                      ├─> desktop host / IPC / install state
                                      └─> training runtime / task modules

agent-activity schema
  ├─> TypeScript host validator
  ├─> Codex bridge selector
  ├─> Rust helper validator
  └─> privacy / bridge manifest validation

release pipeline
  └─> manifest + binary validator + installer lifecycle receipts
```

UI、provider adapter、任务 runtime 和发行脚本不互相读取内部状态。Electron `main.ts` 只选择 composition、启动和关闭服务，不再知道每个子系统的初始化细节。

## 3. 实施工作包

### W1：Composition Root 与能力清单

在 `apps/desktop/src/composition/` 建立共享启动合同和按 profile 选择的能力表。能力清单控制 lifecycle、training、plugin catalog、OpenPets Agent setup、LAN、remote control 和 voice。BrainPet V0.1 只保留主宠、训练、Codex lifecycle、日志、更新和必要窗口。

退出门：两个 profile 的 composition snapshot 可测试；BrainPet tray/Control Center 没有 OpenPets Plugins/Integrations；OpenPets 回归不变。

### W2：完整回退

把 BrainPet feature flag 提升到 composition capability；Local IPC 根据 capability 拒绝 `agent.activity`；pet window 不生成 Primary Companion markup；禁用时不刷新 install marker、不显示首次引导。

退出门：rollback Electron smoke 发送真实 lifecycle 事件，断言无训练入口、无活动徽标、无动作壳、无 BrainPet stage、无 install marker。

### W3：Distribution 与协议单一事实源

新增 `config/brainpet-distribution.json` 和 `config/brainpet-agent-lifecycle.json`。源码与发行验证器必须读取或验证这两个文件；provider matrix 由 adapter 注册表与测试证据校验，不作为独立事实源。

退出门：TS、Rust、Bridge manifest、plugin version、target matrix 任一漂移都会使合同测试失败；隐私政策只描述真实字段。

### W4：Bridge deadline 与 AppImage

原生 helper 和 Node 开发 fallback 共用 2600ms 内部 deadline：初次连接、冷启动轮询和最终发送都只使用剩余预算，为 Codex 的 3 秒进程预算预留 400ms 启动与退出。非 TCP socket/命名管道也通过有界 worker 强制截止。Linux AppImage 标记使用 `APPIMAGE` 原始绝对路径，并验证受支持的版本化文件名。

退出门：陈旧 discovery、慢启动、最终连接超时、runtime 缺失和 20 并发 Hook 都有 wall-clock 测试；AppImage 启动、退出、冷唤醒回执通过。

### W5：安装生命周期状态机

在 `apps/desktop/src/brainpet-installation-state.ts` 建立独立、原子持久化的安装证据与 receipt。runtime 启动、Bridge 人工确认和首条可信 lifecycle 分别记录；Bridge 版本变化后进入重新确认。

退出门：失败可重试；用户确认与自动证据分别持久化；升级导致 Bridge/Hook 版本变化后重新要求确认。

### W6：真实产物验证与发行 profile

二进制验证器解析 PE/Mach-O/ELF header 和目标架构；runtime validator 从 `app.asar`/manifest 验证产品身份，不能把 appId 硬编码进回执。Electron builder 拆分 base、private-test、public-release 三层配置。公开模式必须验签，私测产物和回执明确写 private-test。

退出门：六目标真实 helper 和 runtime directory 通过格式/架构验证；Windows ARM64 使用原生 runner；NSIS、DMG、AppImage、deb 至少生成并进入各自安装测试；公开模式缺签名立即失败。

### W7：本机替换与回退

Windows 本机先生成 private-test 安装包和 Bridge；备份当前 Codex 宠物选择与 BrainPet/OpenPets 用户数据指针，只在用户确认后安装。替换不删除 Codex 原宠资源，只收起原宠并启动 BrainPet；回退为卸载/停用 Bridge、退出 BrainPet、重新唤醒原宠。

退出门：新 Codex 任务自动唤醒 BrainPet；停止/卸载 Bridge 不影响离线训练；移除 runtime 后 Bridge 快速 no-op；有本地安装与回退回执。

## 4. 测试阶梯

1. 纯逻辑：composition、capability、installation state、deadline、marker policy、binary header。
2. 合同：distribution、Agent activity schema、Bridge manifest、provider registry、privacy 字段。
3. Electron：正常 profile、完整回退、首次引导失败重试、真实 lifecycle 验证。
4. 产物：六目标 dry-run、真实 Windows unpacked/installer、PE 架构、Bridge 装配、资源身份。
5. 平台 CI：Windows x64/arm64、macOS Intel/Apple Silicon、Linux x64/arm64。
6. 人工门：Codex 插件安装与 Hook 信任、Windows 当前用户替换、原宠恢复。

## 5. 明确不在本轮处理

- 新游戏、关卡内容和积分经济；
- Claude Code、WorkBuddy、DeepSeek Harness adapter；
- 语音、消息和 Agent 内任务跳转；
- 联网天梯、账户、支付或商业化；
- 重做宠物 spritesheet 或改变已通过的像素视觉合同。

## 6. 最终退出门

代码门：桌面全量测试、M5.1 合同、Electron 正常/回退 smoke、Windows 真实私测安装包与打包后 runtime smoke 全部通过。安装器真正写入本机和 Codex Hook 信任属于 W7 人工门，必须先取得用户针对精确路径与回退动作的确认。平台门：六平台 CI 真实构建通过；未执行的签名、公证或实机项必须保持 pending。
