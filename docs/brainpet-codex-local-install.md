# BrainPet：本机 Codex 私测替换方案

> 适用日期：2026-08-15。当前是可回退 private-test，不是公开签名发行版。

## 1. 已确认的当前状态

- Codex 原生宠物为内置 `seedy`，配置位于 `D:\CodexData\home\config.toml`；不直接改写未公开的禁用值。
- 已安装 `brainpet-codex-bridge@personal` 0.1.0，源码位于 `C:\Users\fengs\plugins\brainpet-codex-bridge`。
- 新 Bridge 为 0.2.0；本机 private-test 使用 Node fallback，公开发行仍要求六平台原生 helper。
- BrainPet 尚未安装到 `%LOCALAPPDATA%\Programs\BrainPet`，install marker 尚不存在。
- 待安装器：`D:\Dev\Projects\products\brainpet\apps\desktop\dist-brainpet\private-test\BrainPet-PrivateTest-3.4.0-win-x64-setup.exe`；175,806,147 bytes；SHA-256 `c8af844b8219248ac094b89811b6fb55e6dc50ae308fb561d21400218754b064`；结构验证通过，签名状态 `NotSigned`。

## 2. 经确认后执行的动作

1. 在 `D:\Codex-windows\10-jobs\manifests` 写入本次精确 manifest；在 `10-jobs\logs` 保存命令、路径、版本与验证结果，不保存任务内容。
2. 备份当前 Codex 宠物配置文件和 Bridge 0.1.0 源码到本次 manifest 的专用备份目录；不删除原文件。
3. 运行未签名的 per-user NSIS private-test 安装器。预期落点为 `%LOCALAPPDATA%\Programs\BrainPet`，不安装系统服务，不创建未经说明的自启动项。
4. 首次启动 BrainPet，验证 `runtime-install.json` 指向真实 `brainpet.exe`、BrainPet discovery 可连接、训练舞台可开关。
5. 用仓库中的 0.2.0 Bridge 替换 personal marketplace 源，执行 `codex plugin remove brainpet-codex-bridge@personal` 后重新 `add`，再用 `codex plugin list --json` 验证版本与启用状态。
6. 新建一个 Codex 测试任务，按 Codex 自身 UI 接受新版 Hook hash 审核，验证 working / ready lifecycle 能驱动 BrainPet。
7. 仅当 Codex 当前界面提供可见的宠物关闭/收起控件时，用 UI 收起 `seedy`。没有该控件就保留原宠配置，不写未知 TOML 值；此时 BrainPet 已能独立常驻，但“完全替代”仍是产品层模拟，不是 Codex 内部宠物 API 替换。

## 3. 风险

- 安装包未签名，Windows 可能显示 SmartScreen/未知发布者；它只用于本机私测，不得对外分发。
- 更新 Bridge 会改变 Hook hash；Codex 可能要求新任务重新审核，这是预期安全行为。
- 私测 Bridge 依赖本机 Node fallback；公开用户版不能沿用该依赖。
- Codex 没有已验证的原生宠物替换 API，因此不能承诺从配置层彻底接管内置宠物。

## 4. 回退

1. 退出 BrainPet，并从 Windows“已安装的应用”卸载 BrainPet；安装器会删除 install marker，默认保留训练进度。
2. 移除 Bridge 0.2.0，恢复备份的 0.1.0 personal marketplace 源并重新安装；若只想断开 Agent，单独移除 Bridge 即可，离线宠物与游戏不受影响。
3. 恢复备份的 `D:\CodexData\home\config.toml`；若本轮只通过 UI 收起原宠，则直接在 Codex UI 重新显示 `seedy`。
4. 验证 BrainPet 进程、discovery 与 Hook 不再运行，Codex 原生宠物恢复；保留 manifest、日志和备份，直到用户确认删除。

## 5. 完成回执

- 安装器路径、hash、安装落点和签名状态；
- runtime marker 与 discovery 验证；
- Bridge 版本、启用状态和 Hook 审核结果；
- 新 Codex 任务 lifecycle 实测；
- 原宠是已由 UI 收起，还是因缺少稳定开关而暂时保留；
- 一条已实际演练的回退路径。
