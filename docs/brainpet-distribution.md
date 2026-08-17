# BrainPet 安装与公开发行方案

> 状态：RC6 发行门实现中。默认 package 已自动执行真实 validator，Windows x64
> private-test 的 unpacked、NSIS 与包内 Helper 已在本机验证；六目标 GitHub runner、
> DMG/AppImage/deb 生命周期、未签名策略、Sigstore provenance 和物理回执未全部通过前，聚合结果必须保持
> `publicReleaseReady=false`。

主宠替代层的分期、Codex 原生控件覆盖和本轮验收门见
`docs/brainpet-primary-companion-plan.md`。

## 结论

BrainPet 需要两个逻辑组件，但最终体验应表现为一次产品安装：

1. **BrainPet Desktop Runtime**：明确标注 `Unsigned` 的桌面程序，负责透明宠物窗口、缩放、拖动、舞台、游戏、本地状态与更新。Codex 插件本身不能提供系统级透明常驻窗口，因此 runtime 不能省略。
2. **BrainPet Codex Bridge**：很小的 Codex 插件，只订阅官方 lifecycle hooks，并把最小状态写入本机 BrainPet IPC。它不包含游戏，不读取 prompt、tool input/output、transcript 或 cwd。

用户不应该手装 Node、npm 包、复制 JSON 或运行开发命令。BrainPet 应在首次启动时检测 Codex，并提供一个明确的“连接 Codex”步骤；Codex 仍由用户亲自完成插件安装、hook 审核和信任。

## 面向用户的目标流程

1. 用户只从 BrainPet GitHub Release 下载与系统匹配、文件名含 `Unsigned` 的安装包，并核对 Release 页给出的 SHA-256 与 Sigstore provenance。
2. 用户首次运行时阅读操作系统安全警告，确认来源与 hash 后，通过系统提供的单应用确认路径继续；BrainPet 不要求关闭全局安全功能。
3. 首次启动由宠物提示打开托盘的“BrainPet 安装与恢复”。
4. 用户点击“检测并连接”，BrainPet 通过已验证的 Codex CLI 安装包内 marketplace
   完成 Bridge 安装或升级；不要求粘贴路径、打开终端，也不直接编辑 Codex TOML。
5. 新任务中 Codex 展示 hook 定义，用户审核并信任；BrainPet 不代替用户做安全确认。
6. 用户新建一个 Codex 任务；BrainPet 开始显示工作、等待授权和完成状态。
7. 如果要完全替代视觉体验，用户手动收起 Codex 原生宠物。BrainPet 不修改或删除 Codex 原生宠物资源。

可接受的最终人工安全步骤有两类：首次运行未签名安装包时的 **操作系统确认**，以及
首次连接 Bridge 时的 **信任 hook**。安装、升级和卸载 Bridge 均由 BrainPet 明确按钮发起，并保留原子配置备份和脱敏 receipt。

### 系统原生确认路径

- Windows：出现“Windows 已保护你的电脑”时，先核对文件名和 Release hash；只有界面提供绕过时才选择“更多信息”→“仍要运行”。组织策略或 Smart App Control 禁止继续时应停止，不关闭 SmartScreen，不添加 Defender 排除项。微软说明未签名文件会显示该警告，企业策略可能完全禁止绕过：[SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)。
- macOS：首次尝试打开后，到“系统设置”→“隐私与安全性”，仅对 BrainPet 选择“仍要打开/Open Anyway”，再在复现的对话框中确认；不运行 `xattr`、不执行 `spctl --master-disable`，不降低全局 Gatekeeper。苹果明确警告未签名、未公证软件风险，并记录此单应用例外路径：[Open apps safely on your Mac](https://support.apple.com/102445)。
- Linux：AppImage 可能需要在文件属性中允许“作为程序执行”，`.deb` 可用系统软件安装器打开；不需要商店账号。具体安全提示依发行版而异，用户应只使用 Release 原件并核对 hash。

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

- BrainPet Desktop Runtime 使用独立 appId、独立更新通道和卸载项，但按产品决策不做 Authenticode、Developer ID 或 Apple notarization。
- 所有安装包文件名带 `Unsigned`；公开页面必须同步说明平台不会显示已验证发布者。
- GitHub Actions 使用 OIDC 生成 Sigstore keyless provenance；它证明仓库、workflow、提交与文件 digest 的绑定，不替代平台签名。
- BrainPet Codex Bridge 随安装包内置 marketplace 分发，不依赖 ChatGPT/Codex 公共目录注册。
- GitHub Release 提供 runtime 安装包；首次启动通过 BrainPet 按钮调用 Codex CLI 安装内置桥接。
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

## `0dacd88` 历史发行合同（已由 2026-08-16 决策替代）

- `config/brainpet-distribution.json` 是产品身份、Bridge 版本、deadline 与六平台目标矩阵的机器事实源。
- Electron builder 分为 `electron-builder.brainpet.base.yml`、`electron-builder.brainpet.private.yml` 和 `electron-builder.brainpet.public.yml`。私测包进入 `dist-brainpet/private-test`；公开包固定关闭证书签名与公证。macOS 公开构建在 DMG 生成前移除 Electron 上游继承的证书身份（不跟随 Framework symlink），对 app 内每个代码 bundle、native module 与 Mach-O 重新应用 certificate-free ad-hoc 签名并执行 `codesign --verify --deep --strict`；任何 `Authority=` 身份都会失败，DMG 仍要求 `codesign` 返回精确未签名结果。
- `apps/desktop/scripts/brainpet-package.mjs` 只接受平台、架构、产物类型与 `private-test/public-release` 模式；`package:brainpet:matrix` 对六目标和两种模式做无副作用 dry-run。
- `integrations/codex/scripts/assemble-bridge-release.mjs` 只从 CI helper 产物装配插件，并生成逐文件 SHA-256 回执。
- `brainpet:bridge:validate-release` 是二进制发行门；源码 checkout 没有六个 helper 时失败是正确行为。`brainpet:release:test` 是本地源码与装配逻辑门，不替代 Sigstore 或实机验证。
- `.github/workflows/brainpet-portability-gate.yml` 构建六类 runtime/helper 私测产物，不发布 Release；公开候选只能来自专用 public workflow。

## RC6 真实产物与可信回执

- `brainpet-package.mjs` 是默认打包入口；builder 成功后会直接调用
  `validate-brainpet-package.mjs`。不能再通过只运行 builder 绕过产物校验。
- Windows BrainPet 的小型本地像素 surface 使用 Electron 软件合成；renderer sandbox 与 Chromium 独立的
  GPU/crash 边界仍保留，不再使用会把 GPU service 移入未沙箱 browser 主进程的 `in-process-gpu`。
  OpenPets 继续使用 Electron 默认硬件加速路径，二者差异由 composition/source contract 与真实 smoke 固定。
- package receipt 记录支持等级、app 版本、精确 source commit、CI 身份、完整 unpacked runtime
  file/directory tree（含每个文件大小与 SHA-256）、包内 native helper 和每个 installer 的 SHA-256。单目标回执固定写
  `publicReleaseReady=false`，不能越权代替聚合门。
- 私测 portability workflow 在 GitHub 托管的干净 runner 上，对 Windows x64 NSIS、
  macOS arm64 DMG、Linux x64 AppImage/deb 运行真实安装、默认 discovery、包内 helper（先按回执 hash 复制到隔离验收目录，确保卸载后仍能验证 fail-open）、
  Adapter 安装/升级/卸载、冷唤醒、状态保留升级和 runtime 卸载。
- 公开 workflow 反向验证 Windows Authenticode 为 `NotSigned`；macOS app 会先移除 Electron 继承的
  Developer ID/其他证书身份，再使用无需证书和开发者注册的 ad-hoc 签名维持 Apple Silicon 可运行性，
  并拒绝任何 `Authority=` 发布者身份；DMG 本身必须明确返回“完全未签名”，没有 notarization ticket，
  Gatekeeper 必须拒绝自动信任并要求用户确认；
  Linux AppImage 的嵌入签名段必须为空，deb 的 `ar` 成员必须严格只有标准控制/数据成员。
  GitHub-hosted runner 使用 GitHub OIDC 与 Sigstore keyless bundle 为每份 package receipt、
  receipt 中列出的 installer、lifecycle 和 Bridge 回执建立 provenance；Bridge 回执列出每个文件、
  目录、大小和 hash，并拒绝篡改、缺失或额外 tree entry。公开上传目录由严格
  allowlist staging 生成，unpacked runtime 和升级 fixture 不进入公开 artifact。聚合器先绑定 artifact hash，
  再用 `cosign verify-blob` 校验 Fulcio/Rekor bundle 中的 repository、workflow 名称与
  路径、触发事件和精确 source commit；该流程不依赖仅 Enterprise Cloud 私有仓库可用的
  GitHub Artifact Attestations 服务。
- Sigstore public-good 服务会把证书身份与 artifact digest 写入公开透明日志；该身份包含
  repository、workflow/ref 和 commit 元数据，但不会上传安装包、源码、用户配置或人工回执正文。
- `aggregate-brainpet-release-receipt.mjs` 聚合六目标 runtime、四种真实 installer
  lifecycle、六 helper Bridge、Adapter、正式 active-30m/idle-24h 性能回执和人工物理回执。Stable 目标仍缺任何未签名策略、
  provenance、安装或物理用户确认时，只列出 `missingEvidence`，绝不写公开就绪。

### 不可循环的候选、性能与物理回执流程

公开发行严格分成候选、两类独立 intake 与 finalize，全部绑定同一 commit；不能在验收后重新构建安装包：

1. 手动运行 `BrainPet public release gate`。它构建并验证六目标未签名候选、四条
   installer lifecycle、Bridge 和 provenance，生成 `brainpet-public-candidate-receipt`
   与配套 `brainpet-public-provenance`。候选回执包含一次性 256-bit challenge；由于尚无物理回执，此时必须保持
   `publicReleaseReady=false`。
2. 从该候选 run 下载 Windows x64 NSIS 和 macOS arm64 DMG 原件，在两台 Stable
   物理机上同时下载该 run 的候选回执，运行对应验收脚本。脚本会把候选 run id、
   候选回执 SHA-256、一次性 challenge 和安装包 SHA-256 写入回执，拒绝其他候选的安装包。
   intake 后的公开回执只保存这些候选绑定、平台、显示器摘要、安装包
   文件名/大小/hash、平台签名缺席、系统警告与人工确认结果和 reviewer；本地 note 会被清空，不保存
   本机绝对路径、Agent 内容或配置正文。
3. 在 Windows x64 上先执行
   `pnpm brainpet:performance:candidate:prepare -- --run-id <candidate-run-id> --commit <40-char-sha>`。
   维护机必须可调用已认证的 `gh`、`cosign` 3.1.3 和系统 `tar.exe`。该事务只下载上述成功 run 的 Windows x64 package closure、候选聚合回执与 Sigstore bundle；本地准备阶段会对候选回执、package receipt 和 NSIS 逐项执行 `cosign verify-blob`，重新校验 Fulcio/Rekor bundle 的 repository、workflow 名称与路径、触发事件、精确 commit 和 subject bytes，而不是信任任意 JSON bundle 或仅复用 workflow 的自报结论。随后继续绑定
   workflow、run/attempt、commit、receipt/installer hash；在解包前拒绝绝对路径、遍历和冲突路径，再用系统 `tar.exe`
   从原始 NSIS 无安装解出 runtime，并以 package receipt 的完整 runtime tree 复验。随后在同一干净 commit 上分别运行
   `node apps/desktop/scripts/brainpet-performance-gate-runner.mjs start active-30m --candidate <prepared-manifest>` 与
   `node apps/desktop/scripts/brainpet-performance-gate-runner.mjs start idle-24h --candidate <prepared-manifest>`。
   runner 会排除外部 `BRAINPET_*`/`OPENPETS_*` 覆盖、获取跨会话全局租约，并在长测前后重验同一份公开候选；它不再本机重打 private-test 包。
   准备目录只保留候选回执、Windows package receipt 与 NSIS 对应的三份已验签 bundle，拒绝它们之外的 prepared provenance entry；回执绑定 prepared manifest、公开候选回执、NSIS、Sigstore bundle、完整 runtime tree、原始 process/heap/latency timeline、总工作集预算、execution log 前缀和 completion。
   30 分钟 active 必须运行 `cargo-signal`；24 小时 idle 必须连续完成。随后用候选回执生成 performance dispatch envelope；
   protected intake 会再次计算所有预算，并从自己下载且已验签的官方候选目录重算 package receipt、候选聚合回执及其 Sigstore bundle 的 SHA-256；finalize 会再次独立重算同三项，除要求两份回执的 executable、app.asar 与 runtime-tree digest 和公开 Windows 候选完全一致外，也拒绝只让两份性能回执彼此一致的伪摘要。
4. 物理与性能回执中的 reviewer 必须填写将批准 intake 环境的 GitHub 用户名。在仓库中一次性创建
   `brainpet-physical-acceptance` GitHub Environment，把允许确认实机结果的维护者设为 required reviewer，
   启用 Prevent self-review，并关闭管理员绕过；批准者必须与 workflow dispatcher 不同。
   这不需要发布者证书、商店账号或 Secret。分别用下方本地命令生成 physical/performance dispatch envelope；把 payload
   原样填入对应的 `BrainPet physical receipt intake` 或 `BrainPet performance receipt intake`。
   required reviewer 必须把各 envelope 的 `approvalComment` 原样粘贴为 Environment 审批评论；评论绑定候选 run、
   候选回执 SHA-256、一次性 challenge 和精确 payload SHA-256。
   workflow 会从 GitHub 当前 run 的 approval history 读取真实批准者和评论，拒绝无批准记录、自审或
   digest 不匹配，再将 dispatcher、
   environment reviewer、候选绑定和回执内容封入 Sigstore OIDC provenance。最后运行
   `BrainPet public release finalize`，传入候选、physical intake 与 performance intake 三个 run id。finalize 会
   核对来源 workflow、成功状态、精确 commit、候选 run/receipt/challenge、reviewer、artifact/runtime
   hash、预算原始证据和两类 provenance 闭包，再写唯一可为 `publicReleaseReady=true` 的聚合回执及已自验签的 Sigstore bundle。

Windows x64：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/brainpet-physical-acceptance.ps1 -RunInteractive -ArtifactPath <BrainPet-Unsigned-setup.exe> -SourceCommit <40-char-sha> -CandidateReceiptPath <candidate-receipt.json> -OutputDirectory <new-output-dir>
```

macOS arm64：

```bash
node apps/desktop/scripts/brainpet-macos-physical-acceptance.mjs --artifact <BrainPet-Unsigned.dmg> --source-commit <40-char-sha> --candidate-receipt <candidate-receipt.json> --output <new-output-dir>
```

在任一维护环境合并两份回执；stdout 是可粘贴到 intake workflow 的 JSON。人工 note
不得填写用户目录、任务内容、token 或其他敏感材料。

```bash
node scripts/intake-brainpet-physical-receipts.mjs --receipt <windows-receipt.json> --receipt <macos-receipt.json> --candidate-receipt <candidate-receipt.json> --source-commit <40-char-sha> --expected-reviewer <github-username> --emit-dispatch-envelope
```

正式性能回执 envelope：

```bash
node scripts/intake-brainpet-performance-receipts.mjs --receipt <brainpet-active-30m.json> --receipt <brainpet-idle-24h.json> --candidate-receipt <candidate-receipt.json> --source-commit <40-char-sha> --expected-reviewer <github-username> --emit-dispatch-envelope
```

physical/performance intake 都不允许 rerun：任何失败都必须新建一次 workflow dispatch，再使用新 run 的审批评论；
finalize 会拒绝任一 `run_attempt != 1` 的 intake artifact。

当前发行策略不需要七个 Windows/macOS 签名 Secret，也不需要 Apple Developer 或商店注册。
这些值不得随机生成或写入仓库。workflow 只使用 GitHub 自带 OIDC 获取短期 Sigstore 身份；
若产物意外带平台签名、上传闭包存在额外内容、没有 provenance，或实机回执未绑定候选和受保护 reviewer，发行门应 fail closed。

## Runtime 支持等级

| 目标 | 当前等级 | 升级条件 |
| --- | --- | --- |
| Windows x64 | Stable | 未签名状态、Sigstore、NSIS 生命周期和系统警告物理回执全部绑定同一 commit |
| macOS arm64 | Stable | 未签名/未公证状态、Sigstore、DMG 生命周期和系统警告物理回执全部绑定同一 commit |
| macOS x64 | Beta | 完成独立真实安装与物理回执后再评估 Stable |
| Linux x64 | Beta | AppImage/deb 生命周期与可信 provenance 已进入 RC6 门；仍按首发扩展门管理 |
| Windows arm64 | Preview | 原生 runner、安装/卸载和未签名用户确认回执齐全后升级 |
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

- 六目标安装包均明确标注 `Unsigned`，没有平台签名；具有独立 appId、卸载和更新回退。
- GitHub/Sigstore provenance、SHA-256、系统警告与用户确认必须绑定同一候选提交。
- Helper 无 Node/npm 依赖，冷启动和单次 hook 总耗时有实测预算。
- 插件 manifest 有图标、主页、仓库、隐私政策、许可证和支持链接。
- 完成四类真实 Codex hook 实测：工作、等待授权、完成、任务结束。
- 多任务并发不会互相覆盖；BrainPet 关闭/崩溃不会阻塞 Codex。
- 安装、信任、新任务生效、升级重新信任和卸载均有人工回执。

Bridge 使用包内 marketplace，不要求公共目录上架；插件安装后需新开任务，插件 hooks 使用与其他 hooks 相同的 hash-based 信任审核。
