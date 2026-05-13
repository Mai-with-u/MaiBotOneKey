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

Windows x64 NSIS 安装包会同时产出两个变体：`full` 完整包包含内置 Python 与 Git，`lite` 精简包不包含内置 Python 与 Git，会在运行时自动寻找系统 Python 3.12+ 与系统 Git。打包前需要在仓库根目录放好完整 payload：

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
  MaiBot-Napcat-Adapter/
  napcat/
```

只构建 `lite` 变体时，`runtime/python/` 与 `runtime/git/` 可以省略：

```bash
bun run release:win:lite
```

发布前检查：

```bash
bun run release:check
```

生成两个安装包：

```bash
bun run release:win
```

产物输出到 `release/`，文件名会带上 `full` 或 `lite` 后缀。`runtime/` 和 `modules/` 会作为 `extraResources` 放进完整包；`lite` 变体会排除 `runtime/python/` 与 `runtime/git/`，缺失时会在环境检查中提供 Python 和 Git 下载入口。

## CI

- `.github/workflows/ci.yml`：在 Linux、macOS、Windows 上执行依赖安装、类型检查和 Electron 构建，不需要 release payload。
- `.github/workflows/release-windows.yml`：手动触发 Windows x64 安装包构建，可输入 payload zip URL；构建完整包时 zip 内需要包含 `runtime/` 和 `modules/`。

更多发布细节见 [docs/release.md](docs/release.md)。
