# MaiBot OneKey Desktop

MaiBot OneKey 的 Electron 桌面壳。当前桌面版负责初始化检查、服务启动/停止、单安装目录单实例、日志/状态展示，以及 MaiBot WebUI、NapCat WebUI、PTY 终端、设置状态页的统一入口。

旧的 `.bat` 和根目录 Python 启动入口已经清理，普通用户入口统一为 Windows 安装包。

## 开发

```bash
bun install
bun run dev
```

本地预览默认使用 `bun run dev`。除非特别说明要验证 `out/` 构建产物或发布形态，不要优先使用 `bun run preview`。

常用检查：

```bash
bun run typecheck
bun run build
```

## 运行时资源

打包版默认把可写运行资源放在 `%APPDATA%\MaiBotOneKeyDesktop\<安装目录hash>` 下；设置中心的「实例路径」页可以迁移运行时资源目录。迁移只移动 `modules/` 与 `python-overrides/`，日志、实例锁和一键包设置仍保留在用户数据目录。

## Windows 打包

Windows x64 NSIS 安装包当前产出正式版：`MaiBot OK-<version>-win.exe`。正式版会打包干净的基础 Python、内置 Git、MaiBot、NapCat、SnowLuma 以及 NapCat/SnowLuma 适配器插件，但不会打包 MaiBot Python 依赖，也不会打包 `python-overrides` 覆盖层；首次启动时再由启动器安装运行依赖。

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
  opencode/
    opencode.exe
modules/
  MaiBot/
    plugins/
      napcat-adapter/
      snowluma-adapter/
  napcat/
  SnowLuma/
```

`runtime/python` 必须保持干净，只允许 Python 自身和 `pip`/`setuptools`/`wheel` 等基础启动包；不要把 MaiBot、dashboard 或其它应用依赖预装进 `runtime/python/Lib/site-packages`。`release-assets/python-overrides` 不会进入安装包。

编写器里的 OpenCode 入口依赖内置 CLI sidecar：打包前需要把 Windows x64 版 `opencode.exe` 放到 `runtime/opencode/opencode.exe`。当前接入按 `opencode-windows-x64` release binary 设计，`runtime/` 已被 `.gitignore` 忽略，所以该二进制不会进入源码提交；`bun run release:check` 会校验它是否存在。

OpenCode 默认启用内置插件编写说明：源码里的 `resources/opencode/plugin_code.md` 会在打包时复制到安装包资源目录的 `runtime/opencode/plugin_code.md`，启动 OpenCode 时通过 `OPENCODE_CONFIG_CONTENT.instructions` 自动指向它，并用 `OPENCODE_DISABLE_PROJECT_CONFIG=true` 跳过 MaiBot 自带 `AGENTS.md`。设置中心可以关闭这个行为，关闭后 OpenCode 会恢复按项目默认规则读取说明文件。

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
release/MaiBot OK-<version>-win.exe
release/MaiBot OK-<version>-win.exe.blockmap
release/latest-win.yml
```

## CI

- `.github/workflows/ci.yml`：在 Linux、macOS、Windows 上执行依赖安装、类型检查和 Electron 构建，不需要 release payload。
- `.github/workflows/release-windows.yml`：手动触发 Windows x64 安装包构建，可输入 payload zip URL；zip 内需要包含 `runtime/` 和 `modules/`，其中 `runtime/opencode/opencode.exe` 用于编写器内置 OpenCode。

更多发布细节见 [docs/release.md](docs/release.md)。
