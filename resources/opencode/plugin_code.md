# MaiBot 插件 Coding Agent 指南

你正在 MaiBot 根目录中工作，目标通常是编写、修改或排查 `plugins/` 下的第三方插件。本说明依据 MaiBot Plugin SDK 2.x 当前开发指南整理；遇到接口疑问时，以官方 SDK 文档和当前 MaiBot 随附的 SDK 实现为准。

## 首要规则

- 插件必须位于 `plugins/<plugin_folder>/`，并作为独立目录维护；不要修改 MaiBot 根目录的 `.gitignore`。
- 除非用户明确授权，不要修改 MaiBot 核心代码、启动脚本、全局配置模板或 `src/` 下的模块。
- 插件运行在独立 Runner 子进程中，**不得导入 `src.*`**。发送消息、访问配置、数据库、LLM 等操作必须通过 `self.ctx` 提供的能力代理完成。
- 入口文件必须命名为 `plugin.py`，并定义无参数的模块级函数 `create_plugin()`，返回 `MaiBotPlugin` 子类实例。
- SDK 插件必须覆盖 `on_load()`、`on_unload()`、`on_config_update(scope, config_data, version)` 三个异步生命周期方法；缺少任意一个都可能被 Runner 拒绝加载。
- 新插件使用 `@Tool` 表达可由模型调用的能力。`@Action` 仅用于兼容旧插件，除迁移既有代码外不要新增 Action。
- 插件只申请实际使用的能力，并把它们写入 `_manifest.json` 的 `capabilities`。未声明的能力调用会被 Host 拒绝。
- 插件运行数据使用 `self.ctx.paths.data_dir`，临时文件使用 `self.ctx.paths.runtime_dir`；不要依赖源码目录或 MaiBot 工作目录拼接运行时路径。

## 权威参考

- 插件 SDK 开发指南：https://github.com/Mai-with-u/maibot-plugin-sdk/blob/main/docs/guide.md
- 插件提交规范：https://github.com/Mai-with-u/plugin-repo/blob/main/CONTRIBUTING.md
- 当前 MaiBot 示例：`plugins/hello_world_plugin/`
- 当前插件的 `_manifest.json`、README、配置和既有代码

文档与本地代码不一致时，先核对当前安装的 MaiBot 与 `maibot-plugin-sdk` 版本，不要凭旧插件示例猜测接口。

## 推荐工作流程

1. 阅读目标插件的 `_manifest.json`、`plugin.py`、`config.toml`、README 和依赖文件，确认插件 ID、版本、SDK 范围、能力与已有组件。
2. 明确需求属于命令、模型工具、事件、Hook、插件 API、消息网关、首页卡片还是 LLM Provider，选择最小的正式组件。
3. 先列出会调用的 `self.ctx` 能力，再同步维护 Manifest 的 `capabilities`；不要为了省事申请一组宽泛权限。
4. 涉及配置时同步修改 `config_model`、`config.toml`、默认值、字段说明和配置版本。
5. 涉及后台任务、连接、文件句柄或缓存时，在 `on_load()` 初始化，并在 `on_unload()` 可靠清理。
6. 修改后做语法检查、必要的单元测试与 Manifest 检查，并向用户说明改动和验证结果。

## 目录结构

```text
plugins/<plugin_folder>/
  _manifest.json     # Manifest v2：兼容范围、依赖、能力等
  plugin.py          # 唯一约定的插件入口
  config.toml        # 可选：插件配置
  README.md          # 推荐：安装、用法、配置、排错
  CHANGELOG.md       # 可选：插件更新日志
  requirements.txt  # 可选：插件额外 Python 依赖
  utils.py           # 可选：插件内部模块
```

不要把日志、缓存、数据库、下载产物、用户数据、密钥或临时文件提交到插件仓库。

## 最小插件模板

```python
from typing import Any

from maibot_sdk import Command, MaiBotPlugin, Tool
from maibot_sdk.types import ToolParameterInfo, ToolParamType


class ExamplePlugin(MaiBotPlugin):
    async def on_load(self) -> None:
        self.ctx.logger.info("示例插件已加载")

    async def on_unload(self) -> None:
        return None

    async def on_config_update(
        self,
        scope: str,
        config_data: dict[str, object],
        version: str,
    ) -> None:
        del scope
        del config_data
        del version

    @Tool(
        "echo_text",
        description="返回调用方提供的文本，适合在需要复述短文本时使用。",
        parameters=[
            ToolParameterInfo(
                name="text",
                param_type=ToolParamType.STRING,
                description="需要返回的文本",
                required=True,
            ),
        ],
    )
    async def echo_text(self, text: str, **kwargs: Any) -> dict[str, object]:
        del kwargs
        return {"success": True, "message": text}

    @Command("ping", description="检查插件是否正常工作", pattern=r"^/ping$")
    async def ping(self, stream_id: str = "", **kwargs: Any) -> tuple[bool, str, int]:
        del kwargs
        message = "pong"
        if stream_id:
            await self.ctx.send.text(message, stream_id)
        return True, message, 1


def create_plugin() -> ExamplePlugin:
    return ExamplePlugin()
```

注意：

- `Tool` 当前推荐使用统一的 `description`。`brief_description`、`detailed_description` 是兼容字段，不要在新代码中继续使用。
- `Tool` 参数优先使用 `ToolParameterInfo` 和 `ToolParamType` 声明；返回值应是可序列化且便于模型理解的数据。
- `Command` 返回 `(success, response, priority)`，其中 `priority` 使用整数。
- 不要覆盖 `get_components()`；Runner 会自动收集装饰器组件以及动态 API。

## 正式组件选择

当前 SDK 推荐使用以下八种正式声明装饰器：

- `@API`：向其他插件暴露可调用接口。需要跨插件访问时设置 `public=True`，调用方使用 `self.ctx.api.call()`。
- `@Command`：正则匹配用户显式命令，适合 `/help`、`/time` 等确定入口。
- `@Tool`：供 LLM Agent 规划和调用，适合查询、计算、转换以及轻量业务操作。
- `@EventHandler`：监听消息或生命周期事件；按事件类型选择同步拦截或异步观察，处理逻辑应保持轻量。
- `@HookHandler`：在明确的 Host Hook 点执行逻辑，可配置顺序、模式和错误策略；不要再使用已经移除的 `WorkflowStep`。
- `@MessageGateway`：接入外部消息平台或网关，负责链路状态和消息收发。
- `@HomeCard`：向 MaiBot WebUI 首页提供静态或结构化卡片。
- `@LLMProvider`：实现新的模型提供方。除代码装饰器外，还必须在 Manifest v2 的 `llm_providers` 中静态声明。

兼容入口：

- `@Action` 会被 SDK 转换为 Tool 声明，仅用于旧插件迁移。
- `WorkflowStep` 已移除，不能作为兼容方案；将旧逻辑迁移到 `HookHandler`。

选择原则：显式指令用 Command；让模型决定何时调用用 Tool；消息链观察或拦截用 EventHandler/HookHandler；插件间复用用 API。不要用常驻事件处理器模拟一个简单命令。

## 生命周期与运行机制

Runner 的关键顺序如下：

1. 发现 `plugin.py` 并调用 `create_plugin()`。
2. 注入 `PluginContext` 和插件配置。
3. 向 Host 获取 capability 授权。
4. 收集并注册组件。
5. 调用 `on_load()`，通过后插件才进入 ready 状态。
6. 配置更新时调用 `on_config_update()`。
7. 卸载或热重载时调用 `on_unload()`，随后注销组件并清理 Runner。

`on_load()` 执行时，上下文、配置、能力与组件注册已经就绪，可以调用 `self.ctx`。但不要在其中执行长时间阻塞的网络请求，否则会拖延 Runner ready 和热切换。

热重载会创建新的 Runner generation，预热成功后才切换；失败时 Host 可能继续保留旧实例。因此初始化逻辑必须可重复执行，模块级状态不能假设跨重载保留。

## 配置模型

需要强类型配置和 WebUI Schema 时，使用 `PluginConfigBase`、`Field` 与插件类的 `config_model`：

```python
from maibot_sdk import Field, MaiBotPlugin, PluginConfigBase


class PluginSection(PluginConfigBase):
    __ui_label__ = "插件设置"
    __ui_icon__ = "settings"
    __ui_order__ = 0

    enabled: bool = Field(default=True, description="是否启用插件")
    greeting: str = Field(
        default="你好",
        description="默认问候语",
        json_schema_extra={
            "label": "问候语",
            "placeholder": "请输入问候语",
        },
    )


class ExampleConfig(PluginConfigBase):
    plugin: PluginSection = Field(default_factory=PluginSection)


class ExamplePlugin(MaiBotPlugin):
    config_model = ExampleConfig
```

配置约定：

- `config.toml` 的层级与配置模型字段保持一致。
- `self.config` 是校验并补齐默认值后的强类型对象。
- `Field(..., json_schema_extra=...)` 可声明 `label`、`hint`、`placeholder`、`x-widget`、`x-icon`、`depends_on`、`depends_value`、`step` 和字段级 `i18n`。
- 配置节可通过 `__ui_label__`、`__ui_order__`、`__ui_icon__`、`__ui_i18n__` 定义 WebUI 展示。
- `Literal[...]` 可自动生成选择项；`list[Literal[...]]` 可生成多选。
- 插件自身配置更新的 `scope` 为 `self`；订阅全局配置更新时只使用 SDK 公布的 `bot`、`model` 作用域常量。
- 未声明 `config_model` 时，可以使用 `await self.ctx.config.get(...)` 读取配置。
- 配置结构变化时同步调整配置版本和迁移说明，不要直接修改 MaiBot 的主配置模板。

## Manifest v2

`_manifest.json` 使用 `manifest_version: 2`。至少认真维护以下内容：

- `id`：稳定且唯一，使用至少两段的字母、数字或下划线，并以点号或横线分隔，例如 `author.example-plugin`。
- `version`：严格三段式语义版本，例如 `1.0.0`。
- `name`、`description`、`author`、`license`、`urls`：插件展示和来源信息。
- `host_application`、`sdk`：经过实际验证的兼容版本区间，不要无依据放宽。
- `dependencies`：插件依赖或 Python 包依赖；避免重复依赖和依赖自身。
- `capabilities`：实际需要调用的 Host 能力，去重且不能包含空值。
- `i18n`：默认语言、支持语言与本地化资源路径。
- `llm_providers`：仅当插件声明 `@LLMProvider` 时维护对应静态声明。
- `changelog`：可选，使用插件内 Markdown 相对路径或 HTTP(S) URL。

示例骨架：

```json
{
  "manifest_version": 2,
  "id": "author.example-plugin",
  "version": "1.0.0",
  "name": "示例插件",
  "description": "演示 SDK 2.x 插件结构",
  "author": {
    "name": "Author",
    "url": "https://example.com"
  },
  "license": "MIT",
  "urls": {
    "repository": "https://example.com/example-plugin"
  },
  "host_application": {
    "min_version": "1.0.0",
    "max_version": "1.99.99"
  },
  "sdk": {
    "min_version": "2.0.0",
    "max_version": "2.99.99"
  },
  "dependencies": [],
  "capabilities": [
    "send.text"
  ],
  "i18n": {
    "default_locale": "zh-CN",
    "locales_path": "_locales",
    "supported_locales": [
      "zh-CN"
    ]
  }
}
```

不要照抄示例中的兼容上限、URL 或能力；应根据目标插件实际情况填写。

## 能力代理速查

所有 Host 功能都从 `self.ctx` 获取。按需求查阅官方文档中的具体签名，常见入口包括：

- `self.ctx.api`：查询或调用其他插件公开 API。
- `self.ctx.gateway`：消息网关注册、状态和入站消息。
- `self.ctx.send`：发送文本、图片、语音、转发、混合消息等。
- `self.ctx.db`：插件数据持久化。
- `self.ctx.llm`：调用 Host 管理的模型。
- `self.ctx.config`：读取插件配置。
- `self.ctx.emoji`：查询表情资源。
- `self.ctx.message`：查询消息。
- `self.ctx.frequency`：频率与节流能力。
- `self.ctx.component`：查询、加载、重载和卸载组件或插件。
- `self.ctx.chat`：查询或打开已有聊天流。
- `self.ctx.person`：查询用户身份和字段。
- `self.ctx.render`：将 HTML 渲染成图片。
- `self.ctx.knowledge`：搜索知识库。
- `self.ctx.tool`：读取可用工具定义。
- `self.ctx.statistics.local`：读取本机统计数据。
- `self.ctx.maisaka`：触发主动任务或追加上下文。
- `self.ctx.logger`：标准 `logging.Logger`。

不要自行计算聊天流或会话 ID。优先使用组件传入的 `stream_id`；需要主动打开私聊或群聊时，先调用 `self.ctx.chat.open_session()` 获取真实聊天流。

## 文件、状态与日志

- 持久数据写入 `self.ctx.paths.data_dir`。
- 缓存、下载暂存和渲染中间文件写入 `self.ctx.paths.runtime_dir`。
- 内存状态放在插件实例字段上，不要依赖不可重建的模块级单例。
- 后台 `asyncio` 任务、线程、连接和文件句柄必须在 `on_unload()` 中取消或关闭。
- 使用 `self.ctx.logger.debug/info/warning/error/critical` 或标准库 `logging`；这些日志会由 Runner 转发到 Host。
- 不要使用已经移除的 `await self.ctx.logging.info(...)` 异步日志接口。

## 安全与可靠性

- 异步处理器中避免阻塞 I/O；网络请求设置合理超时，并给用户返回可操作的错误原因。
- 不要把用户输入直接拼接进 shell 命令、文件路径、SQL 或未经转义的正则表达式。
- 文件访问限制在 Runner 授予的插件数据目录、运行时目录或用户明确授权的路径。
- 不在日志中输出令牌、Cookie、密码、私聊内容或完整敏感配置。
- EventHandler 和 HookHandler 默认保持轻量；高成本任务放入受控后台任务并实现卸载清理。
- 调用返回值遵循对应组件或 capability 的文档，不要用宽泛 fallback 隐藏接口错误。

## 依赖

- 插件 SDK 环境要求 Python 3.10 或更高版本。
- 插件额外 Python 依赖放入插件自己的 `requirements.txt`，并在 Manifest 的 `dependencies` 中按当前协议声明。
- 不要直接修改 MaiBot 的 `pyproject.toml` 或全局 `requirements.txt` 来满足单个插件。
- 引入第三方依赖前确认许可证、体积、平台兼容性以及是否会与 Host 已安装版本冲突。

## 验证与排错

最低检查：

```bash
uv run python -m compileall plugins/<plugin_folder>
```

插件有测试时执行：

```bash
uv run pytest plugins/<plugin_folder>
```

提交前确认：

- `plugin.py` 存在，`create_plugin()` 无参数并返回正确实例。
- 三个必需生命周期方法都已实现。
- 没有导入 `src.*`，所有 Host 交互均通过 `self.ctx`。
- 新能力使用 Tool 而不是 Action，未继续使用 `WorkflowStep`。
- Tool 使用 `description` 和准确的参数定义。
- Manifest v2 JSON 合法，版本、兼容范围、依赖、LLM Provider 与 capabilities 和代码一致。
- 配置模型、`config.toml`、默认值、WebUI 元数据和配置版本一致。
- 数据与临时文件使用标准运行时路径。
- 热重载后不会残留任务、线程、连接或文件句柄。
- README 说明安装、使用、配置、依赖、兼容范围和常见故障。

排错时先看 Runner/Host 日志、Manifest 校验错误和 capability 拒绝信息。精准修复根因，不要通过捕获所有异常、伪造成功返回或静默 fallback 掩盖问题。
