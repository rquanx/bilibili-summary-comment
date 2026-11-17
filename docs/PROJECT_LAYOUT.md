# 项目文件导航

## 代码与工具

| 路径 | 内容 |
| --- | --- |
| `src/commands/` | CLI 入口，业务实现放入对应领域模块 |
| `src/domains/` | B 站、字幕、总结、流水线与调度业务 |
| `src/infra/` | 配置读取、SQLite/Postgres 存储与迁移 |
| `src/shared/` | 日志、锁、时间、路径及 CLI 公共工具 |
| `tests/` | 按模块组织的 Node 测试 |
| `tools/asr/` | Python 转写工具与模型预加载工具 |
| `tools/maintenance/` | 构建、清理、事件巡检及 prompt 验证工具 |
| `tools/setup/` | 环境安装脚本 |
| `config/` | 可提交的业务配置，不存放密钥 |
| `deploy/` | 独立服务配置，见[部署索引](../deploy/README.md) |

批量本地视频转写工具已归入 `tools/asr/transcribe_videos.py`，从仓库根目录运行：

```bash
python tools/asr/transcribe_videos.py <视频目录> --output-dir <字幕目录>
```

工具默认使用 CUDA；模型未缓存时可能下载模型，整理文件时无需运行转写。

根目录保留 npm、TypeScript、Docker 配置与协作规则。Docker 和安装脚本使用 `package-lock.json`；保留既有 `pnpm-lock.yaml`，本次不转换依赖或刷新锁文件。

## 文档与数据库

- [SETUP.md](SETUP.md)：环境配置。
- [DOCKER.md](DOCKER.md)：Docker 运行及 GPU 增量构建。
- [SCHEDULE.md](SCHEDULE.md)：定时调度。
- [POSTGRES.md](POSTGRES.md)：Postgres 配置与迁移。
- [SYNC_ALERTS.md](SYNC_ALERTS.md)：外部同步任务失败／恢复告警。
- `drizzle/`：ORM 迁移及其快照；`postgres/schema.sql`：Postgres 建表文件；`sql/`：运维查询。三者用途不同，分别保留。
- `skills/`：项目工具的使用说明。

## 本地文件

以下目录和文件不提交 Git，也不作为 Docker 根构建上下文内容：

- `.env`、`.env.*`（示例文件除外）、`.auth/`、`apikey.json`、`resend`：本地配置、授权及密钥。保留既有位置，避免影响外部调用。
- `work/`：视频、字幕、总结、数据库、日志和恢复状态。尤其 `work/.comment-submissions/` 不可当缓存删除。
- `temp/`、`.tmp/`、`.tmp-tests/`：临时研究、截图、预览及测试产物。
- `.3.11/`、`node_modules/`、`dist/`、`__pycache__/`、`.videocaptioner/`、`.trending/`：环境、构建或本地工具状态。

根目录散落的 `t.md`、`todo.md`、`Untitled-2.html` 已归档至本机 `temp/project-notes/`，保留原始内容。此次整理不删除视频、数据库、备份、密钥或恢复记录。
