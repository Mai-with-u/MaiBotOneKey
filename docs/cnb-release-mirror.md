# CNB 发布镜像

目标仓库：<https://cnb.cool/Mai-with-u/MaiBotOneKey>。

GitHub 继续保存正式发布；`Sync release to CNB` 工作流把指定正式版本的附件、版本号和发布说明复制到 CNB。只接受包含 Windows exe 的稳定版本，不重新打包，也不修改 GitHub Release。

## 配置与首次同步

1. 在 GitHub 仓库 Actions Secrets 中设置 `CNB_TOKEN`。令牌限定 CNB 目标仓库，需 `repo-code:rw` 和 `repo-release:rw` 权限。不要把令牌写进源代码或客户端。
2. 将工作流及同步脚本合入 GitHub 默认分支。
3. 在 Actions 中打开 `Sync release to CNB` → Run workflow。留空 tag 同步 GitHub 最新正式版本；也可填写完整历史 tag。
4. 成功后确认 CNB Release 安装包可匿名下载，且 `https://cnb.cool/Mai-with-u/MaiBotOneKey/-/git/raw/cnb-updates/latest.json` 返回 JSON。

以后正式发布事件会自动同步。如果先发布空 Release、再上传附件，自动运行会失败；附件全部上传后手动重跑。发布新版本时优先在草稿中上传完整附件，然后正式发布。已安装的旧客户端仍使用 GitHub，需要升级到包含 CNB 支持的启动器才能使用新源。

## 更新行为

客户端先读取 CNB `cnb-updates` 分支的公开 `latest.json`，5 秒超时或清单无效时回退 GitHub API。清单只在附件全部上传、公开下载验证成功后提交。补同步旧版本不会把旧版本标成最新。CNB 正常响应但镜像滞后时，客户端以清单版本为准，因此需要关注同步工作流失败。

清单包含版本说明、文件名、大小和 SHA-256。下载地址由客户端固定仓库、版本号和文件名生成，不接受清单中任意外部下载地址。CNB 下载失败或校验失败时，重试 GitHub 的同一版本、同一文件并再次校验。SHA-256 用于检测损坏，不替代安装包代码签名。

同步可重跑，已存在附件需内容一致，否则停止，不覆盖安装包。只向 CNB 推送当前发布 tag 和专用 `cnb-updates` 分支，不镜像覆盖主分支。多个同步运行串行执行；所有附件上传并验证后才发布清单。

当前使用官方 CNB API 的三步上传：获取上传 URL、PUT 文件、POST 确认。参考官方 `@cnbcool/cnb-cli` 1.17.45 内置 OpenAPI 定义。按官方附件插件说明对单文件施加小于 5 GB 的限制。

## 验证

```sh
bun test scripts/tests/launcher-update-mirror.test.ts
python -m unittest discover -s scripts/tests -p test_cnb_release_sync.py
bun run typecheck
```

本地测试不读取 CNB_TOKEN，也不上传文件。真实同步只能在拥有令牌的环境运行；GitHub Secrets 无法从本地读取。

首页版本提示与更新面板使用同一套 CNB 优先逻辑；CNB 清单没有当前平台可用的安装包时也回退 GitHub 官方。安装包初始地址仅允许本项目 CNB、GitHub 官方仓库，不使用第三方 GitHub 镜像；允许官方服务正常重定向到其文件分发地址。连接等待 15 秒、传输连续无数据 30 秒后尝试备用源。
