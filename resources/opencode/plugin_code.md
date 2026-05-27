# MaiBot 插件 Coding Agent 指南

你正在 MaiBot 根目录中工作，目标通常是编写、修改或排查 `plugins/` 下的插件。除非用户明确授权，不要修改 MaiBot 核心代码、启动脚本、全局配置模板或根目录的 `.gitignore`。

## 工作边界

- 插件代码放在 `plugins/<plugin_name>/` 独立目录中；新插件应包含 `_manifest.json`、`plugin.py`，需要可配置项时再添加 `config.toml`。
- 如果需求必须改动主程序、SDK 或 `src/` 下核心模块，先向用户说明原因、影响范围和替代方案，再请求确认。
- 不要把实验数据、日志、缓存、数据库、临时下载文件提交进插件目录。
- 项目首选语言是简体中文，面向用户的说明、日志、配置描述和 WebUI 文案优先使用简体中文。

## 优先参考

- 官方插件 SDK 文档：https://github.com/Mai-with-u/maibot-plugin-sdk/blob/main/docs/guide.md
- 插件提交规范：https://github.com/Mai-with-u/plugin-repo/blob/main/CONTRIBUTING.md
- 本地示例插件：`plugins/hello_world_plugin/`
- 如果当前插件已有 README、注释或配置说明，以插件内现有约定为准。

## 开发流程

1. 先阅读目标插件的 `_manifest.json`、`plugin.py`、`config.toml` 和 README，确认插件 ID、权限、SDK 版本和已有组件。
2. 根据需求选择最小组件：能用 Command 解决的不要做常驻 EventHandler，能用插件内部状态解决的不要改全局状态。
3. 修改后检查 manifest 的 `capabilities` 是否覆盖实际调用的能力，例如发送文本、图片、转发、表情、配置读取等。
4. 涉及配置字段时，同步更新 `config_model`、`config.toml`、默认值、字段描述和配置版本。
5. 完成后给出改动文件、关键行为和建议的验证命令。

## SDK 组件速查

- `Command`：用户显式发送命令时触发，适合 `/help`、`/time`、`/xxx 参数` 这类确定入口。
- `Tool`：供模型按需调用，适合查询、计算、格式转换、轻量业务动作；返回内容应短、明确、可被模型继续使用。
- `Action`：让 MaiBot 在对话规划中主动执行动作，适合问候、提醒、发送上下文相关内容；要写清触发条件和适用消息类型。
- `EventHandler`：监听消息或生命周期事件，适合日志、统计、转发、自动处理；默认应保持轻量，避免每条消息都做高成本操作。
- `MaiBotPlugin`：插件主类，通常声明 `config_model`，并按需要实现 `on_load`、`on_unload`、`on_config_update`。
- `PluginConfigBase` 和 `Field`：定义可配置项。字段描述会影响用户理解，保持短句、明确默认行为。

## 推荐文件结构

```text
plugins/<plugin_name>/
  _manifest.json
  plugin.py
  config.toml
  README.md
```

`_manifest.json` 至少要关注：

- `id`：使用稳定、唯一的插件 ID，例如 `author.plugin-name`。
- `version`：插件自身版本。
- `host_application` 和 `sdk`：声明兼容范围，不要随意放宽到未验证版本。
- `capabilities`：只声明实际需要的能力。
- `dependencies`：如需第三方包，说明用途，并考虑用户安装成本。

## 常见实现约定

- `plugin.py` 中优先保持导入清晰：标准库、第三方库、SDK、本地模块分组。
- 异步组件里避免阻塞调用；需要文件或网络操作时考虑超时、异常处理和失败提示。
- 向聊天流发送消息时优先使用当前传入的 `stream_id`，不要自行计算会话 ID。
- 不要把用户输入直接拼进正则、路径或命令；路径要限制在插件目录或用户明确指定的位置。
- 返回给用户的错误信息要说明可操作原因，日志里可以保留更详细的异常。
- 如果插件维护内存状态，放在插件实例字段上，并在 `on_unload` 中清理定时任务、后台任务和连接。

## 配置辅助

- 配置模型字段名应和 `config.toml` 分组保持一致。
- 新增配置时提供安全默认值，默认不要开启高风险或高频行为。
- 修改配置结构时提升 `config_version`，并在 README 或注释中说明迁移点。
- 除非用户明确要求，不要修改 MaiBot 主配置文件；插件配置只改当前插件目录内的 `config.toml`。

## 调试与验证

- 优先精准定位问题根因，不要为了排查一个插件问题大范围重构。
- 先看插件目录、manifest、配置和最近日志，再决定是否需要运行命令。
- 依赖管理优先使用 `uv`。如果修改依赖声明，以 `pyproject.toml` 为准，并同步需要的 requirements 文件。
- 常见检查命令：

```bash
uv run python -m compileall plugins/<plugin_name>
uv run python -m pytest tests
```

如果项目没有对应测试或当前环境缺依赖，要在最终说明里明确未运行的原因。

## 提交前自查

- 插件目录完整，manifest JSON 合法，插件 ID 没有和已有插件冲突。
- SDK 组件的名称、描述、参数和返回值足够清晰。
- 权限声明与实际调用一致，没有多声明高权限能力。
- 配置默认值安全，README 能让用户知道如何启用、如何使用、如何排错。
- 没有改动 MaiBot 核心代码、根目录 `.gitignore`、无关格式化或 unrelated 文件。
