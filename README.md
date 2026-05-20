# MaiBot OneKey Desktop

MaiBot OneKey 的 Electron 桌面壳。当前桌面版负责初始化检查、服务启动/停止、单安装目录单实例、日志/状态展示，以及 MaiBot WebUI、NapCat WebUI、PTY 终端、设置状态页的统一入口。

旧的 `.bat` 和根目录 Python 启动入口已经清理，普通用户入口统一为 Windows 安装包。

## 开发

```bash
bun install
bun run dev
```

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
modules/
  MaiBot/
    plugins/
      napcat-adapter/
      snowluma-adapter/
  napcat/
  SnowLuma/
```

`runtime/python` 必须保持干净，只允许 Python 自身和 `pip`/`setuptools`/`wheel` 等基础启动包；不要把 MaiBot、dashboard 或其它应用依赖预装进 `runtime/python/Lib/site-packages`。`release-assets/python-overrides` 不会进入安装包。

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
- `.github/workflows/release-windows.yml`：手动触发 Windows x64 安装包构建，可输入 payload zip URL；zip 内需要包含 `runtime/` 和 `modules/`。

更多发布细节见 [docs/release.md](docs/release.md)。
