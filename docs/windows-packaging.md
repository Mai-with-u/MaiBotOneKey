# Windows 标准安装包

工程保留 `runtime/python` 作为基础 Python 环境，包含引导工具与预装组件。环境二进制由 .gitignore 排除，不提交到 Git。

`bun run release:win` 依次检查资源、构建应用，生成：

- `release/MaiBot-OK-<version>-win.exe`

NapCat 和 SnowLuma 仅支持已有安装的启动、WebUI 和配置，安装包排除其运行文件。干净 Python 环境放入 `resources/runtime/python`，首次运行复制到可写的环境目录并安装 MaiBot 及依赖。

Windows 安装包在基础 Python 中预装 `imageio-ffmpeg`、`playwright`、`jieba`、`Babel` 和 `faiss-cpu` 及其依赖，不再另带 wheel 文件。新环境复制基础 Python 后，从用户配置的镜像补齐缺失或版本不匹配的依赖。已有实例继续使用原环境，按已有版本锁重建环境时也以版本锁为准。

构建目录为 `release/standard`。安装程序与 blockmap 会复制到 `release` 根目录，根目录的 `latest.yml` 和 `latest-win.yml` 指向安装包。

打包命令仅生成本地安装程序，不上传或发布 GitHub Release。
