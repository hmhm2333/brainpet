# BrainPet V1 M0–M8 完成审计

> 日期：2026-08-14
> 口径：代码、测试、产物和外部回执分开；缺少直接证据即不算通过。

| 里程碑 | 当前证据 | 状态 |
| --- | --- | --- |
| M0 需求与证据包 | PRD 第 2–4 节、`brainpet-foundation.md`、两张 mapping | 完成 |
| M1 合同与 Exerciser | `brainpet-runtime.md`、Task Contract、Runtime/Stage/Exerciser 测试 | 完成 |
| M2 Host Adapter | feature flag、宠物配件、Windows native shape、锚定 sandbox 窗口、IPC 白名单、回退 smoke、用户手动首击确认 | 完成；双屏物理门待外部 |
| M3 Runtime 与 Stage | 状态机、逻辑时钟、资源/场景/音效/HUD/暂停/结算、开发工具 | 完成 |
| M4 基础设施硬化 | 100 次 Electron 生命周期、30 分钟 soak、固定 seed、崩溃隔离、第二模块 | 自动与单屏门完成；混合 DPI/锁屏实机待外部 |
| M5 玩法与视觉定型 | 两张 mapping、`brainpet-v1-visual-system.md`、版本化参数表 | 视觉完成；参数负责人批准待外部 |
| M6 Go/No-Go | 第一关规则测试、3 block、关卡/分数、指标与完整局视觉测试 | 完成 |
| M7 持续更新 | 固定容量滚动更新、候选污染防线、关卡/分数、第二模块边界测试 | 完成 |
| M8 QA 与私测包 | 类型/专项/完整局/回退/unpacked/视觉测试、进程清理、回退说明、物理回执脚本 | 开发 QA 完成；外部放行待回执 |

## 仍需直接证据的放行项

1. 两块物理显示器、不同缩放组合及两屏四边锚定。
2. 真实 `Win+L` 解锁和真实 Agent 在局中完成。
3. 认知任务负责人批准 `brainpet-v1-parameter-freeze.md`。
4. 首次用户在不看外部说明时通过第一关理解两款规则。
5. 独立评审者查看两款任务动态过程并签署视觉检查。
前两项必须在相应 Windows 硬件上运行；后三项需要独立责任人。没有 `overallStatus: passed` 的外部回执前，项目状态是“开发验收完成，V1 物理/内容放行待复核”，不是“全部验收通过”。
