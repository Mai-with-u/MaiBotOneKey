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

## Windows 打包

第一版只发布 Windows x64 NSIS 安装包。打包前需要在仓库根目录放好完整 payload：

```text
runtime/
  python31211/
modules/
  MaiBot/
  MaiBot-Napcat-Adapter/
  napcat/
```

发布前检查：

```bash
bun run release:check
```

生成安装包：

```bash
bun run release:win
```

产物输出到 `release/`。`runtime/` 和 `modules/` 会作为 `extraResources` 放进安装包，应用运行时从 Electron resources 目录读取它们。

## CI

- `.github/workflows/ci.yml`：在 Linux、macOS、Windows 上执行依赖安装、类型检查和 Electron 构建，不需要 release payload。
- `.github/workflows/release-windows.yml`：手动触发 Windows x64 安装包构建，可输入 payload zip URL，zip 内需要包含 `runtime/` 和 `modules/`。

更多发布细节见 [docs/release.md](docs/release.md)。
