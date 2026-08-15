# BrainPet Agent 平台方案：A / B / C 验证

> 文档类型：历史原型 ADR，记录 `0dacd88` 基线的 A/B/C 验证。
> 其中完整宿主、训练插件 façade 与 discovery fallback 不再代表目标架构；
> 当前设计与退出门见 `brainpet-release-infrastructure-completion-plan.md`。

## 目标

BrainPet 不抛弃 OpenPets，也不依赖注入 Agent 私有 UI。产品由一个可发行的
完整 OpenPets 宿主、一个训练插件和多个能力诚实的 Agent 适配器组成。三条
路径可以共同进入最终产品，而不是互斥选型。

## A：完整 OpenPets 宿主 + BrainPet Training 插件

历史验证状态（`0dacd88`）：当时已完成代码、合同、packaged runtime 与 Electron smoke 测试。

BrainPet 使用独立产品身份和数据目录，但保留 Control Center、插件平台、
Agent 配置、LAN、远程控制和语音等 OpenPets 能力。新 profile 只默认启用
`brainpet.training`，避免启动与训练无关的默认插件。

训练插件只声明 `commands` 和 `bus`：宠物入口执行 `train` 命令，插件发布
`brainpet.training/open`，主进程的可信订阅者负责透明舞台、宠物锚点和游戏
runtime。插件不能取得 Electron 窗口、文件系统或游戏内部对象。

回退变量 `BRAINPET_ENABLED=0` 只关闭 BrainPet 增量能力；OpenPets 的常驻宠物
和通用 Agent 功能继续可用。

Windows x64 实测冷启动到宠物可用约 639ms；冷空闲约 581MiB，游戏中约
826MiB，关闭舞台后的热空闲约 707MiB。崩溃隔离与恢复通过，但完整
Electron/OpenPets 宿主的常驻内存仍偏高，属于后续性能里程碑，不标记为已优化。

## B：Codex 能力对齐

历史验证状态（`0dacd88`）：Bridge 0.3 已安装并按 Codex 当时解析器改用 `PreToolUse` 和
`ErrorOccurred`，移除不会注册的 Claude-only Hook 声明；缓存 Bridge 已通过
working / blocked / idle 本机 IPC smoke。新 Hook 的真实任务测试须在新 Codex
任务中完成，因为当前任务不会热重载插件。

Codex Bridge 把公开 Hook 事件映射到统一 lifecycle/request 协议。只有在
Codex 暴露稳定 request id、结构化选项和可执行接口时，BrainPet 才显示授权、
回复、停止或打开任务按钮；否则只提示用户回到 Codex 原生界面。任何适配器
失败都必须 fail-open，不能阻塞 Agent。

验收覆盖：并发任务聚合、等待用户、完成/失败、任务定位、能力门控、重复响应
防护、Bridge 未运行/版本不匹配和原生界面回退。

## C：通用 Agent 适配器

历史验证状态（`0dacd88`）：Claude 与 OpenCode 已改用共享 lifecycle builder；当时通用客户端在
OpenPets discovery 缺失时仍会回退发现 BrainPet。该回退已在 RC-1 删除，当前配置必须携带
`brainpet|openpets` 显式目标，目标缺失或不可用时 fail-open，不再连接另一产品。
两者均已通过运行中的 packaged BrainPet IPC smoke；OpenCode 另加入串行发送
队列，保证快速连续事件不会把 `idle` 与 `waiting` 乱序。

Codex、Claude Code、OpenCode 等提供者共享同一个有版本的 provider contract：

- 标准 lifecycle 状态和隐私最小活动；
- 显式 capability matrix；
- 可选的结构化 request/action 通道；
- provider 自己的安装、检测与卸载计划；
- 连接失败时不影响宿主 Agent。

新增 Agent 只实现适配器，不修改宠物窗口、训练插件或游戏 runtime。首轮以
Codex、Claude Code、OpenCode 的合同测试和配置 smoke 为准；没有公开接口的
能力保持不可用，不以 UI 模拟或私有注入伪装实现。

## 决策门

最终允许混合使用：A 是发行主体；B 提供 Codex 的最佳体验；C 控制多平台维护
成本。只有厂商未来提供稳定的原生 Pet 扩展点时，才增加可选的“原生壳入口”，
其内部仍调用相同训练插件和 provider contract。
