# MaiBot OneKey Desktop

MaiBot OneKey 的 Electron 桌面壳。当前桌面版负责初始化检查、服务启动/停止、多实例管理（一次运行一个）、日志/状态展示，以及 MaiBot WebUI、NapCat WebUI、PTY 终端、设置状态页的统一入口。

旧的 `.bat` 和根目录 Python 启动入口已经清理，普通用户入口统一为 Windows 安装包。

设置 → 通用 → 启动设置提供「登录后自动启动一键包」和「一键包启动后自动启动服务」两个独立开关，默认关闭。自动启动服务从下次打开生效，等待初始化、协议确认和 QQ 配置就绪；用户手动操作服务后，本次会话不再自动启动。登录自启仅支持 Windows 和 macOS 正式安装版，需用户登录系统；QQ 客户端仍需保持可登录状态。

## 实例与存放位置

Windows 安装器可选择首个实例的存放位置，留空使用原默认位置。该选项只用于新用户初始化；升级优先保留已有实例。选择的位置必须可写、为空且独立于程序安装目录。MaiBot 和 SnowLuma 分别使用所选位置的 `modules/MaiBot` 和 `modules/SnowLuma`。用户确认下载 NapCat 后，启动器才会安装到 `modules/napcat`。

「设置 → 实例管理」管理的是 MaiBot 实例：新建或接入只需选择 MaiBot 目录。一个启动器固定绑定一个 NapCat 目录和一个 SnowLuma 目录，所有 MaiBot 实例共用协议端、QQ 账号配置及协议端启动命令；切换 MaiBot 不更换协议端绑定。不要求统一实例文件夹，各路径均支持「使用已有目录」和「复制迁移」，复制成功后保留源文件。切换实例前停止服务，确认后重启启动器。

共享协议端路径保存于实例索引旁的 `shared-protocols.json`，账号及协议端设置保存在 `protocol-settings/`。升级旧的多组件实例索引时，一次性采用当前选中实例的协议端绑定，并保留原始索引备份 `instances-before-shared-protocols.json`；其他旧协议端目录原地保留，不自动合并或删除。此后修改 NapCat 或 SnowLuma 路径对所有 MaiBot 实例生效。

实例索引保存在 `%APPDATA%/MaiBotOneKeyDesktop/launcher/instances.json`，新实例的启动器设置保存在其下的 `profiles/<实例ID>`；程序安装路径不再决定实例身份。旧版安装的默认目录、`resource-paths.json` 自定义组件路径和 `resource-location.json` 整体目录配置原地接入，旧设置文件不搬动、不覆盖。开发模式使用独立索引，保留原调试路径，不读写正式版实例索引。

移除实例只删除登记，组件文件和运行设置均保留。重置设置保留实例路径；多实例模式提供当前 MaiBot 数据重置，不再提供按公共根目录清空所有文件的操作，避免误删分散存放的其他内容。

### 在开发模式测试多实例

直接运行 `bun run dev` 即可使用多实例，列表默认包含「默认 PyPI 实例」和「源码调试实例」。两者沿用原开发目录、配置和独立运行环境；未准备源码时，先执行 `bun run dev:source`。普通启动选择 PyPI 实例，`dev:source` 选择源码实例；在界面中切换后的重启保留所选实例。使用 `--source` 的独立 checkout 会额外登记为源码实例。默认开发实例可改名，但不能移除。

关闭原来的开发进程，运行 `bun run dev --instances`。此命令启用与安装版相同的实例管理，使用 `%APPDATA%/MaiBotOneKeyDesktop/dev-instances/<工作目录哈希>/` 下的隔离索引、设置和默认实例，不导入正式版或普通开发模式的数据。新建空目录实例后，可测试切换重启、独立配置、改名、组件迁移和移除登记；接入已有实例时建议选择测试副本。`bun run dev --instances --dry-run` 只打印启动方式，不打开 Electron。

安装器的目录选择页仍需通过 Windows 安装包测试；上述开发命令用于应用内多实例流程，不模拟安装器。

## 开发

```bash
bun install
bun run dev
```

本地预览默认使用 `bun run dev`。除非特别说明要验证 `out/` 构建产物或发布形态，不要优先使用 `bun run preview`。

| 命令 | 用途 |
| --- | --- |
| `bun run dev` | 启动 PyPI 安装版 |
| `bun run dev --instances` | 使用独立配置测试多实例 |
| `bun run dev:source` | 启动 `modules/MaiBot-source`，目录缺失时克隆官方 `dev` 分支 |
| `bun run dev:source --update` | 快进更新当前源码的 `dev` 分支，再启动 |
| `bun run dev:source --build-dashboard` | 只重新构建源码 Dashboard |
| `bun run dev:reset --source` | 清空默认源码实例的运行数据、Python 环境和首次引导状态 |
| `bun run dev:reset --source --keep-deps` | 清空默认源码实例的运行数据和首次引导状态，保留 Python 和已安装的依赖 |

源码启动始终使用本地 Dashboard，缺少构建时自动构建。可用 `--source "C:\path\MaiBot"` 指定已有 checkout。先停止 Core 并退出开发窗口，再加 `--update` 快进同步 `origin/dev` 并重建 Dashboard。有未提交的改动或分支分叉时会停止。编辑 Python 后在一键包中重启 Core 即可加载改动。编辑 WebUI 后可用 `bun run dev:source --build-dashboard` 单独重建，支持加 `--source` 或 `--resume`，构建完刷新 WebUI。

要从头测试默认源码实例，先停止 Core 并退出一键包，再用 `bun run dev:reset --source --dry-run` 查看范围，确认后运行 `bun run dev:reset --source`。这会清理 `modules/MaiBot-source` 下的配置、Bot 数据、日志及对应 Python 环境，保留源码、插件目录、已构建的 WebUI 和共享 QQ 配置。随后运行 `bun run dev:source`，打开窗口后点击「启动 MaiBot」。旧的隔离测试目录仍可用 `--resume <run-目录名>` 打开。

启动命令支持 `--dry-run`，只打印计划，不创建目录、不下载、不启动 Electron。控件预览可用 `bun run vite --config vite.renderer.config.ts --open /controls.html`。测试用 `bun test scripts/tests`，也可按功能目录单独运行。

需要重置 PyPI 测试实例时，先停止服务并退出一键包，用 `bun run dev:reset --dry-run` 查看清理范围。`bun run dev:reset` 清理测试数据和协议端配置，保留已安装的 MaiBot 环境；加 `--full` 会清理安装环境。

### Electron dev 启动排障

如果 `bun run dev` 在 `start electron app...` 后立刻退出，并在日志里看到类似下面的错误：

```text
TypeError: Cannot read properties of undefined (reading 'isPackaged')
```

通常是当前 shell 环境里设置了 `ELECTRON_RUN_AS_NODE=1`。这个变量会强制 Electron 以普通 Node 模式运行，导致主进程里的 `electron.app` 为空。

PowerShell 下先清掉该变量，再启动开发版：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
bun run dev
```

如果只是想临时确认当前 shell 是否带了这个变量：

```powershell
$env:ELECTRON_RUN_AS_NODE
```

常用检查：

```bash
bun run typecheck
bun run build
```

## 运行时资源

打包版默认把可写运行资源放在 `%APPDATA%\MaiBotOneKeyDesktop\<安装目录hash>` 下；设置中心的「实例路径」页支持使用已有目录或复制到新目录。

0.7.0 起，新实例默认通过 PyPI 安装 MaiBot，首次安装自动查询并安装当前 Python 包源中兼容的最新正式版，跳过预发布和开发版本；查询失败时提示重试，不回退固定版本，需要联网获取核心及依赖。实例目录保存 `config/`、`data/`、`plugins/`、`logs/`；`.onekey-deployment.json` 记录当前包版本和环境，`.onekey/environments/` 保存独立便携 Python 环境，`.onekey/snapshots/` 保存更新前配置、数据和完整插件快照。复制实例目录时会一并复制环境与快照，原实例保留。

MaiBot 更新窗口的正式版和历史版本来自设置 → 通用中的 Python 包源。更新在独立环境中安装和校验包，切换环境后即完成，不启动 MaiBot，也不复制实例数据。初始化和迁移留到 MaiBot 启动时处理。安装或验证失败时继续使用原环境，切换成功后清理旧环境。启动器启动时也会清理旧环境和旧快照，保留旧版更新中断恢复所需的文件。

已有源码实例在更新窗口选择包版本，点击「迁移到 PyPI」即可升级。新环境通过验证并启用后，启动器删除实例目录中的旧源码和 Git 记录，保留配置、数据、插件和日志。OneKey 打开时也会检查当前 PyPI 实例，清理以前迁移留下的旧源码。源码调试使用独立源码目录。使用自定义启动命令的实例需要恢复默认命令或改用安装版入口。

## Windows 打包

Windows x64 NSIS 构建 `MaiBot-OK-<version>-win.exe`，内置基础 Python、MinGit、MaiBot 首次安装协议和 SnowLuma。首次配置 NapCat 时会从 GitHub 下载安装，已有 NapCat 安装可以继续使用。首次启动时将基础 Python 复制到实例的独立环境，并通过 PyPI 安装指定版本的 MaiBot。

打包前需要在仓库根目录放好 payload：

```text
runtime/
  python/
    python.exe
    DLLs/
    Lib/
    Scripts/pip.exe
  git/
    cmd/git.exe
modules/
  MaiBot/
    plugins/
      napcat-adapter/
      snowluma-adapter/
  napcat/
  SnowLuma/
```

Windows 内置 Git 使用官方 MinGit，通过 `bun run runtime:git` 下载固定版本并校验 SHA-256，替换 `runtime/git`。启动 MaiBot 时优先使用可运行的内置 Git，仅在其缺失或损坏时尝试系统 Git；路径注入子进程的 `PATH` 和 `GIT_PYTHON_GIT_EXECUTABLE`，不修改系统环境变量，不支持自定义 Git 路径。

`runtime/python` 必须保持为便携 Python，只允许 Python 自身、`pip`/`setuptools`/`wheel` 以及启动依赖解析需要的 `packaging`；不要把 MaiBot、dashboard 或其它应用依赖预装进 `runtime/python/Lib/site-packages`。macOS 包内路径是 `runtime/python/bin/python3.12` 或同版本真实二进制，Windows 包内路径是 `runtime/python/python.exe`。

发布前检查：

```bash
bun run release:check
```

构建 Windows 安装包：

```bash
bun run release:patch-nsis
bun run build
bun run scripts/release/build-windows-variants.ts
```

也可以直接执行：

```bash
bun run release:win
```


产物输出到 `release/`：

```text
release/MaiBot-OK-<version>-win.exe
release/MaiBot-OK-<version>-win.exe.blockmap
release/MaiBot-OK-<version>-win-snowluma.exe
release/MaiBot-OK-<version>-win-snowluma.exe.blockmap
release/latest-win.yml
release/latest-win-snowluma.yml
```

## CI

- `.github/workflows/ci.yml`：在 Linux、macOS、Windows 上执行依赖安装、类型检查和 Electron 构建，不需要 release payload。
- `.github/workflows/release-windows.yml`：手动触发 Windows x64 安装包构建，可输入 payload zip URL；zip 内需要包含 `runtime/` 和 `modules/`。

更多发布细节见 [docs/release.md](docs/release.md)。
