# 代码规范
不要修改MaiBot核心代码，你只能在plugins文件夹进行操作


## debug规范
1. 不要总是想找兜底，一定要精准的找到问题的核心，然后提出建议，兜底是不合适，难以维护的。

# 运行/调试/构建/测试/依赖
优先使用uv
依赖项以 pyproject.toml 为准，要同步更新requirements.txt

# 语言规范
项目的首选语言为简体中文，无论是注释语言，日志展示语言，还是 WebUI 展示语言都首要以简体中文为首要实现目标

# Webui规范
涉及显示聊天流信息的，优先显示聊天流实际名称（群名称或 xxx的私聊），而不是session_id

# 会话 ID 规范
除聊天流创建/注册链路外，业务模块不应自行调用 `SessionUtils.calculate_session_id` 计算资源归属 ID。表达学习、黑话、记忆、WebUI、配置匹配等模块应通过 `chat_manager` 的内部接口，基于 platform、目标 ID 和聊天类型解析已存在的真实聊天流；如果解析不到真实 `ChatSession.session_id`，不要把自行计算的 fallback hash 写入数据库。

# 关于 A_memorix 修改
如果修改涉及 `src/A_memorix`，请先阅读 `src/A_memorix/MODIFICATION_POLICY.md`。

# maibot插件开发文档
https://github.com/Mai-with-u/maibot-plugin-sdk/blob/main/docs/guide.md

如果你要编写插件，不要改动根目录的.gitignore，而是在/plugins下创建独立仓库，然后进行编写
如果你要编写插件有需求需要改动主程序代码，请你先请求许可。

# 如何提交maibot插件
https://github.com/Mai-with-u/plugin-repo/blob/main/CONTRIBUTING.md

