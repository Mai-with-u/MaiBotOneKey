# MaiBot OneKey Desktop

MaiBot OneKey 的 Electron 桌面壳。当前桌面版负责初始化检查、服务启动/停止、单安装目录单实例、日志/状态展示，以及 MaiBot WebUI、NapCat WebUI、PTY 终端、设置状态页的统一入口。

旧的 `.bat` 和根目录 Python 启动入口已经清理，普通用户入口统一为 Windows 安装包。

## 开发

```bash
bun install
bun run dev
```

本地预览默认使用 `bun run dev`。除非特别说明要验证 `out/` 构建产物或发布形态，不要优先使用 `bun run preview`。

开发 MaiBot WebUI 与一键包的联动时，使用：

```bash
bun run dev:build # 首次使用或修改 MaiBot Dashboard 后构建
bun run dev:dev
```

`dev:build` 构建 `modules/MaiBot/dashboard/dist`。`dev:dev` 直接使用已有构建启动一键包，不自动构建；缺少构建时会提示先运行 `dev:build`。启动时默认勾选「启动时使用本地 Dashboard 构建」。即使之前保存为关闭，或在本次开发运行中重置设置，也默认开启；仍可在设置中手动关闭。该行为只作用于此开发入口，普通 `bun run dev` 和安装包保持原有设置逻辑。

`dev:dev` 使用独立的 `.cache/dev-python-env` 测试环境，首次从当前已安装的 `python-env` 复制，之后直接复用。如果没有现成环境，则首次初始化安装依赖并保留。启动仍会检查项目依赖，只补装缺失、版本不匹配或损坏的包。普通 `bun run dev` 继续使用原来的 Python 环境。

从零重测首次引导时，先退出运行中的一键包和服务，再执行以下命令；配置和数据会清空，测试环境及已安装依赖会保留：

```bash
bun run dev:reset
bun run dev:dev
```

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

打包版默认把可写运行资源放在 `%APPDATA%\MaiBotOneKeyDesktop\<安装目录hash>` 下；设置中心的「实例路径」页可以迁移运行时资源目录。迁移只移动 `modules/`，日志、实例锁、`python-env` 和一键包设置仍保留在用户数据目录。

## Windows 打包

Windows x64 NSIS 打包一次产出两个安装包：完整版 `MaiBot-OK-<version>-win.exe`，以及不含 NapCat 的 SnowLuma 版 `MaiBot-OK-<version>-win-snowluma.exe`。两版都包含干净的基础 Python、内置 Git、MaiBot、SnowLuma 与共享适配器插件；完整版额外包含 NapCat，SnowLuma 版首次使用默认选择 SnowLuma。MaiBot Python 依赖不会预装进包内 runtime；首次启动时启动器会复制一份可写 `python-env` 并把运行依赖安装到其中。

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
