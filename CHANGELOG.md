# Changelog

本文档从 0.1.10 版本开始记录 MaiBot OneKey Desktop 的主要变化。

## 0.2.2 - 2026-05-13

本版重点：调整 Windows 打包与运行时策略，内置 Python 改为精简基础环境；新增自定义 Python 路径、实例路径管理和终端模式；优化模块更新、环境检查、插件管理与首页展示。

### 打包与发布

- Windows 安装包拆分为 `full` 与 `lite` 变体。
- `full` 包包含精简内置 Python 与内置 Git。
- `lite` 包仍包含精简内置 Python，但不包含内置 Git，运行时会寻找系统 Git。
- 打包检查会校验内置 Python 是否保持精简，避免把业务依赖打进基础 Python。
- 新增并调整 `release:win`、`release:win:full`、`release:win:lite` 等发布脚本。

### Python 运行时

- 内置 Python 仅作为基础环境，不再预装大量 MaiBot 业务依赖。
- MaiBot Core 默认使用“基础 Python + 用户可写覆盖层”的方式启动。
- 新增“自定义 Python 路径”选项，开启后可手动输入、浏览选择或从系统 Python 下拉候选中选择。
- 使用自定义 Python 时，不再使用内置 Python 与覆盖层逻辑，也不再注入 Python 覆盖依赖。
- “Python 覆盖依赖”界面文案改为“手动更新Python 依赖”。
- 手动依赖更新仅维护 `maibot-dashboard` 与 `maim-message`。

### 环境检查

- 合并 Git 检查项，不再区分“Git 运行时”和“Git 可执行文件”。
- 移除“内置 modules 模板”和“机器人 QQ 号”等不适合作为环境依赖的检查项。
- 修复多处环境检查、首页与设置页中的中文乱码显示。
- Python、Git 缺失或版本不满足要求时，会给出更明确的提示。

### 实例路径

- 新增实例路径管理，可迁移或切换 MaiBot、NapCat 等可写资源目录。
- 基础 Python 位置与 Python 覆盖层位置固定，不再允许在实例路径中修改。
- MaiBot 与 NapCat 的资源路径调整会在服务停止后执行，避免运行中切换造成状态错乱。

### 模块更新

- MaiBot 更新失败时不再回退到一键包内置版本，而是恢复到更新前的提交与原始 `origin`。
- 子模块更新失败时同样会恢复到更新前状态。
- 首页与设置页的 MaiBot 更新逻辑保持一致。
- 更新源与 MaiBot 仓库配置整合进 MaiBot Core 更新卡片。
- 移除“远程拉取失败会回退到内置快照”的旧提示。

### 首页与界面

- 修复首页和设置中心多处文本乱码。
- 首页右上角移除 MaiBot / NapCat 快捷按钮。
- 首页保留服务状态、端口健康、一键包版本和 MaiBot 本地版本等核心信息。
- 设置页的 Python 路径输入改为可输入、可下拉、可浏览选择的组合体验。

### 终端与服务

- 新增终端模式设置，可选择内嵌终端或外部 Windows 终端。
- 服务状态会显示内嵌或外部终端的 PID 信息。
- 服务启动时会根据自定义 Python 状态决定是否注入覆盖层。

### 插件管理

- 插件管理支持读取、渲染并保存插件 `config.toml`。
- 支持字符串、数字、布尔值、数组、对象等常见配置类型。
- 移除旧的 napcat-adapter 独立配置卡片，统一通过插件管理维护。

## 0.2.1 - 2026-05-13

本版重点：优化首页、模块更新、启动依赖检查与运行日志体验，并补充 Windows 打包资源检查。

### 首页

- 新增首页，展示服务运行数量、端口健康、一键包版本、MaiBot 版本和 Dashboard 版本。
- 首页提供 MaiBot Core 和 WebUI 更新入口。
- 首页布局调整为更紧凑的工具界面信息密度。
- 远端版本读取改为后台刷新，减少首页打开时的等待。

### MaiBot 更新

- 新增模块更新源配置，可在 GitHub 镜像代理、官方 GitHub 和自定义源之间切换。
- MaiBot 更新支持读取远端 tag，并可选择正式版、测试版或旧版目标版本。
- 移除 MaiBot 更新流程中的 napcat-adapter 独立更新逻辑。
- 移除 napcat-adapter 专用修复入口，模块更新聚焦 MaiBot 主模块。

### 启动依赖

- MaiBot Core 启动前会检查并安装 MaiBot 声明依赖到 Python 覆盖目录。
- 启动依赖安装会写入服务系统日志。
- MaiBot 运行环境注入 `PYTHONPATH`，优先加载覆盖层依赖。
- 依赖更新从“直接全量安装”优化为先检测 requirements / pyproject 依赖是否满足。
- 支持读取 `pyproject.toml` 的项目依赖。
- 依赖更新支持流式输出和取消；启动过程中停止 MaiBot 会中断正在运行的依赖安装进程。
- pip 安装加入 `--no-compile`，减少安装阶段不必要的编译和长时间无反馈。

### 终端与日志

- 终端页会展示启动前依赖更新、服务启动状态等系统日志。
- 附加已有终端会补写最近系统日志，并避免重复写入。
- PTY IPC 容错增强：会话缺失时读取缓冲区返回空内容，`resize` 不再抛出到前端。
- 内嵌 xterm 终端固定使用深色控制台主题，不再跟随应用主题切换。

### 打包与资源检查

- 打包配置改为 `compression: store`。
- Windows payload 检查加入内置 napcat-adapter 插件要求。
- payload 检查增强对 NapCat 版本资源的识别能力。

## 0.2.0 - 2026-05-12

本版重点：加入 MaiBot 插件市场和已安装插件管理，并增强 NapCat 新目录结构下的兼容性。

### 插件市场与插件管理

- 新增 MaiBot 插件市场。
- 新增已安装插件管理页面。
- 支持插件安装、更新、卸载、搜索和操作确认。
- 支持展示插件版本、作者、分类、描述和仓库信息。
- 根据本地 MaiBot 版本判断插件 manifest 兼容性，并在不兼容时给出提示。

### NapCat 兼容性

- NapCat 启动优先使用 `node.exe index.js`，找不到时再回退到 Windows 启动器或 `NapCatWinBootMain.exe`。
- NapCat 配置写入兼容新的目录结构，包括 `napcat/config` 和版本化资源目录。
- 打包资源过滤补充排除 NapCat WebUI 配置，避免把运行时登录配置带入安装包。
- Windows payload 检查增强，要求能定位实际 NapCat 运行资源。

## 0.1.10 - 2026-05-09 至 2026-05-11

本版重点：新增首页、模块更新源、启动依赖检查和服务日志能力，并优化打包资源检查。

### 首页

- 新增首页，展示服务运行数量、端口健康、一键包版本、MaiBot 版本和 Dashboard 版本。
- 首页提供 MaiBot / NapCat WebUI 快捷入口。
- 首页新增 MaiBot Core 和 WebUI 更新入口。
- 首页布局调整为更紧凑的工具界面信息密度。
- 远端版本读取改为后台刷新，减少首页打开时的等待。

### MaiBot 更新

- 新增模块更新源配置，可在 GitHub 镜像代理、官方 GitHub 和自定义源之间切换。
- MaiBot 更新支持读取远端 tag，并可选择正式版、测试版或旧版目标版本。
- 远端同步失败时可回退到一键包内置快照。
- 移除 MaiBot 更新流程中的 napcat-adapter 独立更新逻辑。
- 移除 napcat-adapter 专用修复入口，模块更新聚焦 MaiBot 主模块。

### 启动依赖

- MaiBot Core 启动前会检查并安装 MaiBot 声明依赖到 Python 覆盖目录。
- 启动依赖安装会写入服务系统日志。
- MaiBot 运行环境注入 `PYTHONPATH`，优先加载覆盖层依赖。
- 依赖更新从“直接全量安装”优化为先检测 requirements / pyproject 依赖是否满足。
- 支持读取 `pyproject.toml` 的项目依赖。
- 依赖更新支持流式输出和取消；启动过程中停止 MaiBot 会中断正在运行的依赖安装进程。
- pip 安装加入 `--no-compile`，减少安装阶段不必要的编译和长时间无反馈。

### 终端与日志

- 终端页会展示启动前依赖更新、服务启动状态等系统日志。
- 附加已有终端会补写最近系统日志，并避免重复写入。
- PTY IPC 容错增强：会话缺失时读取缓冲区返回空内容，`resize` 不再抛出到前端。
- 内嵌 xterm 终端固定使用深色控制台主题，不再跟随应用主题切换。

### 打包与资源检查

- 打包配置改为 `compression: store`。
- Windows payload 检查加入内置 napcat-adapter 插件要求。
- payload 检查增强对 NapCat 版本资源的识别能力。

### 清理

- 删除旧的数据迁移说明文本文件。
