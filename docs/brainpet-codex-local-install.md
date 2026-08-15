# BrainPet：本机 Codex 私测替换方案

> 适用日期：2026-08-15。当前是可回退 private-test，不是公开签名发行版。

## 1. 2026-08-15 实装结果

- Codex 原生宠物为内置 `seedy`，已由用户在 UI 中关闭；本轮没有改写 `D:\CodexData\home\config.toml` 中任何未公开宠物配置。
- 已安装 `brainpet-codex-bridge@personal` 0.3.0，源码位于 `C:\Users\fengs\plugins\brainpet-codex-bridge`，Codex cache 位于 `D:\CodexData\home\plugins\cache\personal\brainpet-codex-bridge\0.3.0`。
- 本机 private-test 使用 Node fallback；公开发行仍要求六平台原生 helper。
- BrainPet 3.4.0 已安装到 `%LOCALAPPDATA%\Programs\brainpet`；install marker 和 BrainPet discovery 均已验证。
- 已安装包：`D:\Dev\Projects\products\brainpet\apps\desktop\dist-brainpet\private-test\BrainPet-PrivateTest-3.4.0-win-x64-setup.exe`；175,822,417 bytes；SHA-256 `103c60450de7e88c38e11700e67cfcf2f992a29b503c0f84dbb6226e5ea3d77c`；结构与 packaged preload 白名单验证通过，private-test 不具备公开发行资格。
- packaged runtime 的历史回执曾验证旧训练 façade；当前 Release 已改为内建 TrainingEntry，需以新的 package/physical receipt 为准。Codex、Claude、OpenCode 的标准化 lifecycle 仍通过 BrainPet IPC 合同验证。

## 2. 已执行动作

1. 在 `D:\Codex-windows\10-jobs\manifests` 写入本次精确 manifest；在 `10-jobs\logs` 保存命令、路径、版本与验证结果，不保存任务内容。
2. 保留 Git checkpoint `5634c98` 作为改造前代码回退点；没有修改 Codex 原生宠物配置。
3. 运行未签名的 per-user NSIS private-test 安装器，落点为 `%LOCALAPPDATA%\Programs\brainpet`；没有安装系统服务或创建启动项。
4. 首次启动 BrainPet，验证 `runtime-install.json` 指向真实 `brainpet.exe`、BrainPet discovery 可连接、训练舞台可开关。
5. 用仓库中的 0.3.0 Bridge 替换 personal marketplace 源，执行 `codex plugin remove brainpet-codex-bridge@personal` 后重新 `add`，再用 `codex plugin list --json` 验证版本与启用状态。
6. 当前任务不能热重载新 Hook；下一条新建 Codex 任务应按 Codex 自身 UI 接受新版 Hook hash 审核，再验证真实 working / ready lifecycle。
7. 保持用户已在 UI 中关闭的 `seedy` 状态；BrainPet 已能独立常驻，但“完全替代”仍是产品层模拟，不是 Codex 内部宠物 API 替换。

## 3. 风险

- 安装包未签名，Windows 可能显示 SmartScreen/未知发布者；它只用于本机私测，不得对外分发。
- 更新 Bridge 会改变 Hook hash；Codex 可能要求新任务重新审核，这是预期安全行为。
- 私测 Bridge 依赖本机 Node fallback；公开用户版不能沿用该依赖。
- Codex 没有已验证的原生宠物替换 API，因此不能承诺从配置层彻底接管内置宠物。

## 4. 回退

1. 退出 BrainPet，并从 Windows“已安装的应用”卸载 BrainPet；安装器会删除 install marker，默认保留训练进度。
2. 用 `codex plugin remove brainpet-codex-bridge@personal` 移除 Bridge；若只想断开 Agent，到此即可，离线宠物与游戏不受影响。
3. 如需回退代码，从 Git checkpoint `5634c98` 建立回退分支；不要改写当前分支历史。
4. 在 Codex UI 中重新显示 `seedy`，验证 BrainPet 进程、discovery 与 Hook 不再运行，并保留 manifest 与日志。

## 5. 完成回执

- 安装器路径、hash、安装落点和签名状态；
- runtime marker 与 discovery 验证；
- Bridge 0.3.0 已启用；当前任务不热重载，Hook 审核待下一条新 Codex 任务完成；
- 合成 lifecycle 已实测，真实新任务 lifecycle 待验证；
- 原宠已由用户通过 UI 收起，本轮未写私有配置；
- 回退命令、安装卸载入口和 Git checkpoint 已记录，未执行破坏性回退演练。
