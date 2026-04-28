# Release Engineering

本文档记录桌面版发布流程。当前目标平台是 Windows x64，安装器使用 `electron-builder` 的 NSIS target。

## 本地发布

1. 准备依赖：

   ```bash
   bun install
   ```

2. 准备 release payload。仓库根目录必须存在：

   ```text
   runtime/python31211/bin/python.exe
   modules/MaiBot/bot.py
   modules/napcat/NapCatWinBootMain.exe
   ```

3. 执行发布检查：

   ```bash
   bun run release:check
   ```

4. 构建 Windows x64 安装包：

   ```bash
   bun run release:win
   ```

安装包会输出到 `release/`。

## GitHub Actions 发布

`Windows Release` 工作流是手动触发的。推荐上传一个 payload zip 到稳定位置，然后在工作流输入里填写：

- `payload_url`：zip 下载地址。
- `payload_sha256`：可选，填了会校验 zip 完整性。
- `create_github_release`：是否创建 draft GitHub Release。
- `tag_name`：创建 GitHub Release 时必填，例如 `v0.1.0`。
- `prerelease`：是否标记为预发布。

payload zip 支持两种结构：

```text
payload.zip
  runtime/
  modules/
```

或：

```text
payload.zip
  MaiBotOneKeyPayload/
    runtime/
    modules/
```

## 保留的数据

安装器卸载时不会删除 Electron userData。应用 userData 按安装目录 hash 隔离，所以同一台机器复制两份安装目录时，可以分别运行两套实例与数据。

模块代码更新策略另行实现：后续强制覆盖模块代码时，需要保留配置和数据，并要求用户二次确认。

## Windows 实机冒烟清单

- 安装器可正常安装到默认目录和自定义目录。
- 同一安装目录重复启动只保留一个实例。
- 复制两份安装目录后可以分别启动。
- MaiBot Core 和 NapCat 能被 Electron 启停。
- 端口冲突时明确报错，不复用外部进程。
- 关闭窗口时能选择最小化或全部退出。
- 强杀服务后再次启动不会残留 PTY session。
