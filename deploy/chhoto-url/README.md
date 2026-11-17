# Chhoto URL

2026-11-18 通过 Railway CLI 核实：当前部署 `f3f1553a-ef33-4686-b399-55b7091d31f9`，`SUCCESS`、`deploymentStopped=false`，实例 `RUNNING`。上游版本 7.11.4-alpine，Dockerfile 已固定镜像 digest。

| 配置 | 当前值 |
| --- | --- |
| 项目 / 环境 | summary-paste / production，ID 见[部署索引](../README.md) |
| Railway 服务名 / ID | `kutt` / `a2f6187c-cf58-4f86-b9e1-e55c70025ce3` |
| 公开入口 | https://s.voxwing.top/ |
| 端口 / 健康检查 | 3000 / `/api/version`，超时 90 秒 |
| 存储卷 | `kutt-volume`，挂载 `/var/lib/kutt`，当前状态 READY |
| 数据库 | `/var/lib/kutt/chhoto.sqlite` |

Railway 服务名及卷路径沿用旧名称，实际运行 Chhoto；原 Kutt 应用已被替换。不要创建第二个短链服务，也不要重跑已完成的一次性迁移。

## 服务配置

`Dockerfile` 与 `start.sh` 直接启动上游二进制；`service-settings.json` 及 GraphQL 文件记录 Railway 健康检查、单副本和失败重启策略。

| 变量 | 配置 |
| --- | --- |
| CHHOTO_DB_URL | /var/lib/kutt/chhoto.sqlite |
| CHHOTO_SITE_URL | https://s.voxwing.top |
| CHHOTO_LISTEN_PORT | 3000 |
| CHHOTO_SQLITE_USE_WAL_MODE / CHHOTO_SQLITE_ENSURE_ACID | True |
| CHHOTO_EXIT_ON_NO_AUTH | True |
| CHHOTO_PASSWORD_HASH_ALGORITHM | Argon2 |
| CHHOTO_API_KEY_HASH_ALGORITHM | SHA512 |
| CHHOTO_PUBLIC_MODE | Disable |
| CHHOTO_ALLOW_CAPITAL_LETTERS | True |
| CHHOTO_REDIRECT_METHOD | TEMPORARY |
| CHHOTO_SLUG_STYLE / CHHOTO_SLUG_LENGTH | UID / 6 |
| CHHOTO_TRY_LONGER_SLUG | True |
| CHHOTO_CACHE_CONTROL_HEADER | no-store |

密码、API Key 哈希及会话密钥只通过私有配置提供，不提交。管理员密码使用 Argon2；API Key 使用 SHA-512 的 URL-safe base64 哈希。保持内置数据库备份开启。

## 流水线接入

```dotenv
SHORT_LINK_PROVIDER=chhoto
KUTT_URL=https://s.voxwing.top/
# KUTT_API_KEY 在私有环境中提供
```

`KUTT_URL`、`KUTT_API_KEY` 沿用历史变量名，当前用于 Chhoto。流水线用完整目标 URL 的 SHA-256 前 10 位作为固定短码，通过 `POST /api/new` 创建，再以只读 `QUERY /api/expand` 核对完整目标、启用和永久状态；冲突不覆盖，异常保留原 PrivateBin 链接。短链映射包含解密 fragment，应按私有数据保护，不打印或公开数据库。

## 维护与验证

本目录是独立构建上下文，优先复用固定上游镜像与本地缓存；基础镜像不变时使用 `--pull=false --network=none` 构建。发布前单独确认影响并备份 SQLite，不能直接复制正在写入的数据库文件。

`verify.cjs` 是现用服务的端到端验收脚本，在准备好的 GPU 容器内运行，会创建和删除测试短链及粘贴。运行前必须确认线上数据影响；本次整理未执行该脚本。

参考：[Chhoto URL 7.11.4](https://github.com/SinTan1729/chhoto-url/releases/tag/7.11.4)。
