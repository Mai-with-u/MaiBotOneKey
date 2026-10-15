# MaiBot OneKey Desktop

MaiBot OneKey 的 Electron 桌面壳。当前桌面版负责初始化检查、服务启动/停止、单安装目录单实例、日志/状态展示，以及 MaiBot WebUI、NapCat WebUI、PTY 终端、设置状态页的统一入口。

旧的 `.bat` 和根目录 Python 启动入口已经清理，普通用户入口统一为 Windows 安装包。

## 开发

```bash
bun install
bun run dev
```

本地预览默认使用 `bun run dev`。除非特别说明要验证 `out/` 构建产物或发布形态，不要优先使用 `bun run preview`。

启动入口明确区分 PyPI 与源码，避免根据目录里的旧文件意外选择运行方式：

| 命令 | MaiBot 核心 | Dashboard |
| --- | --- | --- |
| `bun run dev` / `bun run dev:pypi` | PyPI 安装版 | 默认使用已安装的 Dashboard 包 |
| `bun run dev:source` | 本地源码 | 默认使用已安装的 Dashboard 包 |
| `bun run dev:source:webui` | 本地源码 | 使用源码目录中的 `dashboard/dist` |
| `bun run dev:dev` | `dev:source:webui` 的兼容别名 | 同上 |

源码默认放在 `modules/MaiBot-source`，也可以指定已有 checkout（支持带空格的路径）：

```powershell
bun run dev:source --source "C:\path\MaiBot"

# 同时调试源码中的 Dashboard
bun run dev:build --source "C:\path\MaiBot"
bun run dev:source:webui --source "C:\path\MaiBot"
```

源码入口不会自动克隆、更新或覆盖代码，也不接受已经带有 `.onekey-deployment.json` 的 PyPI 实例目录。Python 直接运行该目录的 `bot.py`，编辑 Python 后在一键包中重启 Core 即可加载改动；编辑 Dashboard 后重新执行 `dev:build` 并刷新 WebUI。Electron/React 代码仍由 electron-vite 监听。

每份源码使用独立的 `.cache/dev-source/<源码路径hash>/python-env`，首次从干净的基础 Python 创建，随后复用已安装依赖；启动器设置、日志和协议端可写文件也与 PyPI 模式隔离。配置、数据和插件位于所选源码 checkout 内。源码调试期间禁用一键包对核心的安装、更新及源码目录迁移，更新源码请直接操作该仓库。

命令指定本次启动的 Dashboard 初始选择，仍可在设置中手动调整。`dev:source:webui` 不自动构建，缺少 `dist/index.html` 会提示执行对应的 `dev:build`。所有启动变体支持 `--dry-run`，只验证并打印运行目录，不打开 Electron。

从零重测 PyPI 首次引导时，先退出一键包和服务，再执行 `bun run dev:reset`、`bun run dev`。重置命令只处理 PyPI 测试实例，清空配置和数据，保留已安装环境；不处理独立的源码调试实例。

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

MaiBot 更新窗口的正式版和历史版本来自 Python 包索引，使用设置 → 通用中的 Python 包源。安装或修复会创建新环境、安装核心及插件 `requirements.txt` 中的依赖，执行 `pip check`、包版本及资源检查后再切换。普通启动不自动升级核心或依赖。相同版本可重新安装；「恢复上一环境」会同时恢复更新前的配置、数据库和插件，替换更新后产生的相应实例状态。环境中保留 `onekey-requirements.txt` 供诊断实际依赖组合。

已有源码实例仍使用原启动方式及 Python 环境，启动器不再提供 Core 的 Git 升级或分支切换。在更新窗口选择包版本并点击「迁移到 PyPI」即可切换；无论原实例处于 main、dev、自定义分支还是 detached HEAD，迁移均保留 Git 状态、本地源码修改、旧环境和实例数据，不执行 checkout、pull 或 reset；失败继续使用原实例，也可恢复上一环境退回源码模式。旧的 Git 更新目标不会沿用为 PyPI 目标，包版本需重新选择。源码开发继续使用独立源码目录；安装版用隔离模块入口启动，旧目录中的 `src` 不参与核心导入。用户自定义启动命令需自行调整为安装版入口或恢复默认命令。

## Windows 打包

Windows x64 NSIS 默认构建标准包 `MaiBot-OK-<version>-win.exe`，也可单独构建不含 NapCat 的 SnowLuma 版 `MaiBot-OK-<version>-win-snowluma.exe`。两版都包含干净的基础 Python、内置 Git、MaiBot 首次安装协议、SnowLuma 与共享适配器插件；标准包额外包含 NapCat，SnowLuma 版首次使用默认选择 SnowLuma。MaiBot 源码不会进入安装包；首次启动时将基础 Python 复制到实例的独立环境并通过 PyPI 安装指定版本。

打包前需要在仓库根目录放好 payload：

```text
runtime/
  python/
    python.exe
    DLLs/
    Lib/
    Scripts/pip.exe
  git/
    bin/git.exe
modules/
  MaiBot/
    plugins/
      napcat-adapter/
      snowluma-adapter/
  napcat/
  SnowLuma/
```

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

只构建不含 NapCat 的 SnowLuma 版：`bun run release:win:snowluma`。

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
