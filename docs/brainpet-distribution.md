# BrainPet 安装与公开发行方案

> 状态：`0dacd88` 的历史分发基线。该基线完成过 Windows x64 私测包与 packaged
> runtime smoke，但不等于当前 Release 就绪；当前安装、目标路由、跨平台回执与
> 公开发行门以 `brainpet-release-infrastructure-completion-plan.md` 为准。

主宠替代层的分期、Codex 原生控件覆盖和本轮验收门见
`docs/brainpet-primary-companion-plan.md`。

## 结论

BrainPet 需要两个逻辑组件，但最终体验应表现为一次产品安装：

1. **BrainPet Desktop Runtime**：签名的桌面程序，负责透明宠物窗口、缩放、拖动、舞台、游戏、本地状态与更新。Codex 插件本身不能提供系统级透明常驻窗口，因此 runtime 不能省略。
2. **BrainPet Codex Bridge**：很小的 Codex 插件，只订阅官方 lifecycle hooks，并把最小状态写入本机 BrainPet IPC。它不包含游戏，不读取 prompt、tool input/output、transcript 或 cwd。

用户不应该手装 Node、npm 包、复制 JSON 或运行开发命令。BrainPet 应在首次启动时检测 Codex，并提供一个明确的“连接 Codex”步骤；Codex 仍由用户亲自完成插件安装、hook 审核和信任。

## 面向用户的目标流程

1. 用户从官网、GitHub Releases 或应用商店下载带代码签名的 BrainPet 安装包。
2. 首次启动由宠物提示打开托盘的“BrainPet 安装与恢复”。
3. 用户从 Codex 插件目录安装 BrainPet Bridge。
4. Codex 展示 hook 定义，用户审核并信任；BrainPet 不代替用户做安全确认。
5. 用户新建一个 Codex 任务；BrainPet 开始显示工作、等待授权和完成状态。
6. 如果要完全替代视觉体验，用户手动收起 Codex 原生宠物。BrainPet 不修改或删除 Codex 原生宠物资源。

可接受的最终人工步骤只有两个：**安装插件**和**信任 hook**。这是安全确认，不应伪装成静默自动化。

## 分阶段分发

### 开发验证（当前）

- 个人 marketplace：`brainpet-codex-bridge@personal`。
- Hook 使用本机 Node.js 运行 `bridge.mjs`。
- 适合开发机验证事件映射、隐私边界和 BrainPet IPC；不适合普通用户。

### 封闭测试

- 在 BrainPet GitHub 仓库提供 repo marketplace。
- 测试用户安装签名测试包后，通过 Codex 插件页或一条 marketplace 命令安装桥接。
- BrainPet 内提供连接状态、插件版本、hook 是否待信任和一键打开相应 Codex 页面；不直接改 Codex 配置文件。

### 公开发行

- BrainPet Desktop Runtime 独立签名、独立 appId、独立更新通道和卸载项。
- BrainPet Codex Bridge 提交到 ChatGPT/Codex 共用的公开插件目录。
- 官网的主按钮下载 runtime；首次启动引导用户从插件目录安装桥接。
- Bridge 版本声明最低 BrainPet IPC 版本，runtime 对旧/新 bridge 做兼容协商；二者可独立更新。

## 必须替换的开发依赖

公开版 hook 不应假定用户装有 Node。推荐在插件内携带小型、无依赖的多平台 helper：

```text
brainpet-codex-bridge/
├── .codex-plugin/plugin.json
├── hooks/hooks.json
└── bin/
    ├── windows-x64/brainpet-hook.exe
    ├── windows-arm64/brainpet-hook.exe
    ├── macos-x64/brainpet-hook
    ├── macos-arm64/brainpet-hook
    ├── linux-x64/brainpet-hook
    └── linux-arm64/brainpet-hook
```

Helper 从 stdin 读取 Agent hook、提取允许字段，并向 BrainPet discovery 发送一次本机 IPC。每次连接尝试最多 350ms；热连接、冷启动轮询和最终发送共享 2600ms 内部 deadline，为 Codex 的 3 秒 Hook 预算保留启动与退出余量。若 runtime 未运行，helper 会读取 per-user 安装标记，验证它只指向当前平台的 BrainPet 可执行文件后再启动。Linux AppImage 记录原始 `APPIMAGE` 路径，而不是临时挂载目录。它不启动游戏、不访问网络、不写用户任务内容。

## `0dacd88` 历史发行合同

- `config/brainpet-distribution.json` 是产品身份、Bridge 版本、deadline 与六平台目标矩阵的机器事实源。
- Electron builder 分为 `electron-builder.brainpet.base.yml`、`electron-builder.brainpet.private.yml` 和 `electron-builder.brainpet.public.yml`。私测包进入 `dist-brainpet/private-test`；公开包缺签名/公证凭据时 fail closed。
- `apps/desktop/scripts/brainpet-package.mjs` 只接受平台、架构、产物类型与 `private-test/public-release` 模式；`package:brainpet:matrix` 对六目标和两种模式做无副作用 dry-run。
- `integrations/codex/scripts/assemble-bridge-release.mjs` 只从 CI helper 产物装配插件，并生成逐文件 SHA-256 回执。
- `brainpet:bridge:validate-release` 是二进制发行门；源码 checkout 没有六个 helper 时失败是正确行为。`brainpet:release:test` 是本地源码与装配逻辑门，不替代签名或实机验证。
- `.github/workflows/brainpet-portability-gate.yml` 构建六类 runtime/helper 私测产物，不发布 Release，也不把未签名包称为公开安装包。

托盘“BrainPet 安装与恢复”页给出三类分离证据：runtime 标记与运行版本、用户明确确认已审核 Bridge、新任务是否真的送达首条 lifecycle。状态保存在 BrainPet 独立用户目录，Bridge 版本变化会转为重新确认。暂停或卸载 Bridge 不影响离线宠物与训练；卸载 runtime 会删除安装标记并让 Bridge 快速 no-op，但默认保留用户训练进度。

BrainPet 与 OpenPets 使用独立 discovery 命名空间，避免两款应用同时运行时把 Agent 事件发错进程。macOS 使用 `~/Library/Application Support/BrainPet/runtime/ipc.json`，Windows 使用 `%APPDATA%\\BrainPet\\runtime\\ipc.json`，Linux 优先使用 `$XDG_RUNTIME_DIR/brainpet/ipc.json`。安装标记位于系统的 per-user BrainPet 配置目录；源码 checkout 也只接受 `product=brainpet`、`appId=dev.brainpet.app` 的 discovery，缺失时 fail-open，不回退到 OpenPets。各端使用相同的 `agent.activity` schema v1 和 discovery token。

不推荐把 npm 作为普通用户入口。Codex marketplace 虽可引用 npm 包，但那仍要求本机 npm，并不能提供透明桌面 runtime；npm 只适合开发者分发桥接源码或 CLI。

## 更新、兼容与回退

- IPC 保持版本化；未知字段忽略，未知 lifecycle state 拒绝。
- 插件更新会改变 hook hash，Codex 会要求重新审核；发行说明必须解释原因。
- BrainPet 已安装但未运行时 helper 尝试一次有界冷唤醒；未安装、标记损坏或启动失败时静默 no-op，不改变 Codex hook 结果。
- `SessionEnd/idle` 只通知已运行的 runtime，不会为了清理状态反向冷启动 BrainPet。
- 卸载插件只断开 Agent 状态；BrainPet 仍可作为普通桌宠和离线小游戏运行。
- 卸载 BrainPet runtime 后插件只会快速 no-op；不残留后台服务。
- 原生 Codex 宠物始终由用户自行显示或收起，BrainPet 不接管其内部设置。

## 发布门

- Windows 安装包有代码签名、独立 appId、卸载和更新回退。
- Helper 无 Node/npm 依赖，冷启动和单次 hook 总耗时有实测预算。
- 插件 manifest 有图标、主页、仓库、隐私政策、许可证和支持链接。
- 完成四类真实 Codex hook 实测：工作、等待授权、完成、任务结束。
- 多任务并发不会互相覆盖；BrainPet 关闭/崩溃不会阻塞 Codex。
- 安装、信任、新任务生效、升级重新信任和卸载均有人工回执。

官方依据：Codex 插件可由本地或 repo marketplace 分发测试，也可提交到 ChatGPT/Codex 共用的公开目录；插件安装后需新开任务，插件 hooks 使用与其他 hooks 相同的 hash-based 信任审核。
