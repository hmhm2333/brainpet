# BrainPet 安装与公开发行方案

> 状态：RC6 发行门实现中。默认 package 已自动执行真实 validator，Windows x64
> private-test 的 unpacked、NSIS 与包内 Helper 已在本机验证；六目标 GitHub runner、
> DMG/AppImage/deb 生命周期、签名、公证和物理回执未全部通过前，聚合结果必须保持
> `publicReleaseReady=false`。

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
3. 用户点击“检测并连接”，BrainPet 通过已验证的 Codex CLI 安装包内 marketplace
   完成 Bridge 安装或升级；不要求粘贴路径、打开终端，也不直接编辑 Codex TOML。
4. 新任务中 Codex 展示 hook 定义，用户审核并信任；BrainPet 不代替用户做安全确认。
5. 用户新建一个 Codex 任务；BrainPet 开始显示工作、等待授权和完成状态。
6. 如果要完全替代视觉体验，用户手动收起 Codex 原生宠物。BrainPet 不修改或删除 Codex 原生宠物资源。

可接受的最终人工安全步骤只有 **信任 hook**；安装、升级和卸载 Bridge 均由
BrainPet 明确按钮发起，并保留原子配置备份和脱敏 receipt。

## 分阶段分发

### 开发验证

- 历史个人 marketplace `brainpet-codex-bridge@personal` 只用于旧回执兼容和升级测试。
- 当前仓库 launcher 仅调用对应目标的 native helper；helper 缺失时静默退出，不再
  回退到 Node/npm。`bridge.mjs` 只保留为源码合同测试夹具，不进入 runtime 包。
- 单元测试使用隔离的假 Codex home；不会修改开发者当前 Codex 配置。

### 封闭测试

- runtime 包内置名为 `brainpet` 的本地 marketplace 和当前平台 helper。
- “BrainPet 安装与恢复”页检测 Codex、执行安装/升级/卸载并显示待信任/已验证状态。
- 每次变更先备份 `CODEX_HOME/config.toml`，失败时恢复精确字节；receipt 不保存配置
  正文、prompt、任务内容或工作目录。

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

Helper 从 stdin 读取 Agent hook、提取允许字段，并向 BrainPet discovery 发送一次本机 IPC。每次连接尝试最多 350ms；热连接、冷启动轮询和最终发送共享 2600ms 内部 deadline，为 Codex 的 3 秒 Hook 预算保留启动与退出余量。若 runtime 未运行，helper 会读取 per-user 安装标记，验证它只指向当前平台的 BrainPet 可执行文件后再启动。runtime 同时原子写入 `.bak`；主 marker 损坏或陈旧时 helper 只接受该备份或平台固定 BrainPet 安装位置，不采信损坏内容中的路径。Linux AppImage 记录原始 `APPIMAGE` 路径，而不是临时挂载目录。它不启动游戏、不访问网络、不写用户任务内容。

## `0dacd88` 历史发行合同

- `config/brainpet-distribution.json` 是产品身份、Bridge 版本、deadline 与六平台目标矩阵的机器事实源。
- Electron builder 分为 `electron-builder.brainpet.base.yml`、`electron-builder.brainpet.private.yml` 和 `electron-builder.brainpet.public.yml`。私测包进入 `dist-brainpet/private-test`；公开包缺签名/公证凭据时 fail closed。
- `apps/desktop/scripts/brainpet-package.mjs` 只接受平台、架构、产物类型与 `private-test/public-release` 模式；`package:brainpet:matrix` 对六目标和两种模式做无副作用 dry-run。
- `integrations/codex/scripts/assemble-bridge-release.mjs` 只从 CI helper 产物装配插件，并生成逐文件 SHA-256 回执。
- `brainpet:bridge:validate-release` 是二进制发行门；源码 checkout 没有六个 helper 时失败是正确行为。`brainpet:release:test` 是本地源码与装配逻辑门，不替代签名或实机验证。
- `.github/workflows/brainpet-portability-gate.yml` 构建六类 runtime/helper 私测产物，不发布 Release，也不把未签名包称为公开安装包。

## RC6 真实产物与可信回执

- `brainpet-package.mjs` 是默认打包入口；builder 成功后会直接调用
  `validate-brainpet-package.mjs`。不能再通过只运行 builder 绕过产物校验。
- package receipt 记录支持等级、app 版本、精确 source commit、CI 身份、runtime、
  包内 native helper 和每个 installer 的 SHA-256。单目标回执固定写
  `publicReleaseReady=false`，不能越权代替聚合门。
- 私测 portability workflow 在 GitHub 托管的干净 runner 上，对 Windows x64 NSIS、
  macOS arm64 DMG、Linux x64 AppImage/deb 运行真实安装、默认 discovery、包内 helper、
  Adapter 安装/升级/卸载、冷唤醒、状态保留升级和 runtime 卸载。
- 公开 workflow 还要求 Windows Authenticode、macOS Developer ID + notarization ticket，
  并用 GitHub OIDC/Sigstore 为所有 installer 生成 build provenance；聚合器会离线绑定
  artifact hash，再通过 `gh attestation verify` 验证 repository、signer workflow、
  source commit 和 GitHub-hosted runner。
- `aggregate-brainpet-release-receipt.mjs` 聚合六目标 runtime、四种真实 installer
  lifecycle、六 helper Bridge、Adapter 和人工物理回执。Stable 目标仍缺任何签名、
  公证、安装或物理证据时，只列出 `missingEvidence`，绝不写公开就绪。

当前机器事实：`hmhm2333/brainpet` 尚未配置 BrainPet Windows/macOS 签名凭据；因此
公开 workflow 现在应 fail closed。这是外部发行凭据缺口，不得以 self-signed、ad-hoc
签名或伪造 receipt 替代。

## Runtime 支持等级

| 目标 | 当前等级 | 升级条件 |
| --- | --- | --- |
| Windows x64 | Stable | Authenticode、NSIS 生命周期和物理回执全部绑定同一 commit |
| macOS arm64 | Stable | Developer ID、公证 DMG、生命周期和物理回执全部绑定同一 commit |
| macOS x64 | Beta | 完成独立真实安装与物理回执后再评估 Stable |
| Linux x64 | Beta | AppImage/deb 生命周期与可信 provenance 已进入 RC6 门；仍按首发扩展门管理 |
| Windows arm64 | Preview | 原生 runner、安装/卸载和厂商信任回执齐全后升级 |
| Linux arm64 | Preview | 原生 runner、安装/卸载回执齐全后升级 |

托盘“BrainPet 安装与恢复”页给出三类分离证据：runtime 标记与运行版本、Codex/Bridge 检测安装状态、新任务是否真的送达首条 lifecycle。状态、配置备份和操作 receipt 均保存在 BrainPet 独立用户目录；Bridge 版本变化会使旧 lifecycle 证据失效。暂停或卸载 Bridge 不影响离线宠物与训练；卸载 runtime 会删除主/备安装标记并让 Bridge 快速 no-op，但默认保留用户训练进度。

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
