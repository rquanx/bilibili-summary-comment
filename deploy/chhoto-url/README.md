# Chhoto URL 替换 Kutt（2026-11-15 已上线）

当前版本：上游 `7.11.4-alpine`，镜像已固定 digest `sha256:c68314649b6bfc18dcb376842175e07161ef052b86af98c7fb4a6a6a46d69613`。Railway 部署 `f3f1553a-ef33-4686-b399-55b7091d31f9` 已确认 SUCCESS、deploymentStopped=false、实例 RUNNING。

## 切换范围

- 保留 `https://s.voxwing.top`、当前 Railway 短链 service ID `a2f6187c-cf58-4f86-b9e1-e55c70025ce3` 及域名证书。基础设施暂沿用服务名 `kutt`，应用替换为 Chhoto。
- 保留卷 `/var/lib/kutt`，新数据库使用 `/var/lib/kutt/chhoto.sqlite`；原 `/var/lib/kutt/data.sqlite` 不覆盖、不删除。
- 保留 PrivateBin 服务及所有粘贴内容。
- GPU 流水线只替换 `src/domains/bili/short-link.ts` 并设置 `SHORT_LINK_PROVIDER=chhoto`。`KUTT_URL`、`KUTT_API_KEY` 沿用历史变量名，继续用于当前短链服务；默认 provider 仍为 kutt，方便回退。
- 原 Kutt 账号体系切换为 Chhoto 单管理员密码，沿用原管理员密码，不再需要输入邮箱。API Key 沿用现有值，在 Chhoto 变量中保存 SHA-512 的 URL-safe base64 哈希。
- 等待正在运行的评论任务完成后，短暂停止 GPU 流水线；通过独立 SQLite `BEGIN IMMEDIATE` 事务锁住 Kutt 写入，生成最终快照后转换并校验，再切换应用。新部署接管时旧容器和锁事务退出；公网旧链接、新建链接验收通过后恢复流水线。

## 配置

| 变量 | 值 |
|---|---|
| CHHOTO_DB_URL | /var/lib/kutt/chhoto.sqlite |
| CHHOTO_SITE_URL | https://s.voxwing.top |
| CHHOTO_LISTEN_PORT | 3000 |
| CHHOTO_SQLITE_USE_WAL_MODE | True |
| CHHOTO_SQLITE_ENSURE_ACID | True |
| CHHOTO_EXIT_ON_NO_AUTH | True |
| CHHOTO_PASSWORD_HASH_ALGORITHM | Argon2 |
| CHHOTO_API_KEY_HASH_ALGORITHM | SHA512 |
| CHHOTO_PUBLIC_MODE | Disable |
| CHHOTO_ALLOW_CAPITAL_LETTERS | True |
| CHHOTO_REDIRECT_METHOD | TEMPORARY |
| CHHOTO_SLUG_STYLE | UID |
| CHHOTO_SLUG_LENGTH | 6 |
| CHHOTO_TRY_LONGER_SLUG | True |
| CHHOTO_CACHE_CONTROL_HEADER | no-store |

密码、API Key 哈希及会话密钥仅通过私有文件/stdin 配置，不提交或打印。保持内置数据库备份开启。网页随机短码使用 6 位，冲突时可加长；流水线继续使用目标完整 URL 的 SHA-256 前 10 位作为固定短码。

官方 Alpine 镜像不包含 `taskset`；保持官方线程配置，不额外安装组件。`start.sh` 直接 exec 上游二进制作为 PID 1，无守护 shell、无额外反向代理。本地完成密码登录及接口验收后，Docker working set 约 7.65 MiB。

## 迁移和验证

`migrate-kutt.py` 仅读取源 SQLite 快照，以独占创建方式写入新数据库，保留短码、完整目标字符串、点击数、有效期、启停状态和备注；不迁移浏览器、地区等明细统计。遇到密码保护或自定义域名链接时中止，避免静默丢失访问保护。启动后由 Chhoto 创建自己的索引及 FTS 表。

当前只读快照含 1 条短链，无密码链接和自定义域名映射；已完成本地转换、完整目标及字段逐项比较、SQLite integrity_check。私有快照在 `.auth/chhoto-migration-20261115/`，不可公开。最终上线前须重新采集快照，避免迁移期间漏掉新链接。

流水线适配使用固定版本实际源码：`POST /api/new` 成功返回完整短链 URL；短码冲突为 HTTP 400。随后用只读 `QUERY /api/expand` 核对完整目标、启用状态和永不过期状态；不重复 POST、不覆盖冲突链接、不记录密钥。所有失败保留原始 PrivateBin 链接。

本地及待部署 GPU 镜像内的 8 项相关测试通过。GPU 镜像 `video-pipeline:gpu-chhoto-ready` 从当前运行镜像离线增量构建，已验证源码仅有 `short-link.ts` 一处变化。

## 上线验收与资源

- 最终快照仍为 1 条短链，目标字符串及全部迁移字段逐项一致；新库传输前后 SHA-256 一致。原库保留为 `/var/lib/kutt/data.sqlite`，新库为 `/var/lib/kutt/chhoto.sqlite`，WAL、ACID 和自动备份已开启。
- 从公网验证旧短链 307 跳转和完整 PrivateBin fragment 一致；创建、解密、新建短链、重复请求复用、匿名写入拒绝、错误 API Key 拒绝、原密码登录全部通过。
- 恢复后的实际 GPU 容器再次运行 `verify.cjs` 全流程验收通过；验收短链和对应粘贴已删除。首次本地网络代理排查遗留的一条临时粘贴设为 5 分钟过期，至最终验收时已超过有效期。
- GPU 已运行 `video-pipeline:gpu-chhoto-ready` 对应镜像（config digest `sha256:615a7509cb0206131599fb1772f9f3d943e509e1688f395f961c50c1fe668683`），环境 `SHORT_LINK_PROVIDER=chhoto`；调度日志确认恢复运行。
- Railway 分钟内存指标：切换前约 0.150–0.154 GB，切换后连续两个样本约 0.00443 GB（4.43 MB，短时空闲样本，不代表峰值）。原 Kutt 部署已 REMOVED，不再并行运行。认证 Argon2 会产生短时内存峰值。
- 浏览器公共入口正常显示 Chhoto 密码登录框；未更改 DNS、PrivateBin、Postgres、已有 B 站评论。临时本地服务和测试网络已移除。

## 回退

保留当前 Kutt 部署 `bf0f0969-b15b-4d4d-ac63-6a2a3ec1375b`、原数据库、原 Railway 变量和原 GPU 镜像。若切换验收失败，恢复健康检查 `/api/v2/health`、Kutt 镜像和 GPU 环境/镜像。若 Chhoto 已产生真实新链接，回退前先导出并合并这些链接，不能直接回退丢失新短码。

## 参考

- https://github.com/SinTan1729/chhoto-url/releases/tag/7.11.4
- https://github.com/SinTan1729/chhoto-url/blob/7.11.4/backend/src/services/post.rs
- https://github.com/SinTan1729/chhoto-url/blob/7.11.4/backend/src/services/query.rs
- https://github.com/SinTan1729/chhoto-url/blob/7.11.4/backend/src/database/queries.rs
