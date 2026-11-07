# Windows 标准安装包

工程保留 `runtime/python` 作为干净 Python 环境，仅包含 pip、packaging 等引导工具。环境二进制由 .gitignore 排除，不提交到 Git。

`bun run release:win` 依次检查资源、构建应用，生成：

- `release/MaiBot-OK-<version>-win.exe`

安装包内置 SnowLuma。用户首次配置 NapCat 时，启动器从 GitHub 下载并安装。干净 Python 环境放入 `resources/runtime/python`，首次运行复制到可写的环境目录并安装 MaiBot 及依赖。

`release:win:standard` 是默认打包命令的别名。

构建目录为 `release/standard`。安装程序与 blockmap 会复制到 `release` 根目录，根目录的 `latest.yml` 和 `latest-win.yml` 指向安装包。

打包命令仅生成本地安装程序，不上传或发布 GitHub Release。
