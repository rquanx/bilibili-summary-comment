# PrivateBin / Kutt 阿里云部署（2026-11-15 已完成）

> 已撤回：用户确认域名未备案，2026-11-15 授权迁回 Railway。当前生产服务在 Railway，阿里云目录仅作备份保留，不应执行 compose up。迁回过程见 `RETURN-TO-RAILWAY.md`。下文为此前迁移记录。

目标主机：`voxwing-aliyun`，目录 `/opt/voxwing-paste`。
公网域名继续使用 `privatebin.tool.voxwing.top` 和 `s.voxwing.top`。
不迁移 Postgres，不修改 GPU 流水线配置或已有 B 站评论。

## 当前状态与验收

- 两个域名均已由原 Railway CNAME 改为 DNS-only A 记录 `120.79.205.83`，TTL 自动；原所有权 TXT 保留。
- Caddy 已分别取得两个域名的 Let's Encrypt 证书，自动续期，证书数据保存在 `data/caddy`。
- 原 PrivateBin 16 条加密粘贴、Kutt 1 个管理员和 1 条短链已迁入。SQLite 完整性检查通过。
- 历史短链已验证目标地址（包括解密 fragment）完全一致，历史内容通过公共 HTTPS 独立解密，浏览器新版阅读页显示正常。
- 运行中 GPU 容器通过公共 HTTPS 完成新内容加密创建、读取解密、短链创建与跳转、匿名创建拒绝以及验收数据清理。
- Railway `privatebin` 部署 `0e406a6d-8b70-490c-b7fa-d5cf4e1f5080` 和 `kutt` 部署 `5dc21a37-1cd7-489d-9b52-066b8b5ed428` 的 `deploymentStopped` 均已确认 `true`。API 的历史部署 `status` 仍显示 `SUCCESS`，不能用它判断实例是否运行。
- 最终观察：PrivateBin 24 MiB、Kutt 181 MiB、Caddy 15 MiB；主机可用内存约 852 MiB，采样期间 swap 换入换出均为 0。此为验收时点，不代表负载峰值。
- 阿里云防火墙原本已放行 TCP 80/443，未修改防火墙或原有容器。
- ICP 备案状态尚未得到用户答复；切换时两个域名的定向公网和正式 HTTPS 均正常，未遇接入拦截。
- 本机初始/最终备份位于忽略目录 `.auth/aliyun-paste-migration-20261115/`；服务器副本在 `/opt/voxwing-paste/backups/`。Kutt 数据包含完整 PrivateBin 密钥链接，应按私有数据保管。

## 镜像与入口

- PrivateBin 复用本机 `privatebin:reader-ready`，离线导出并传输；保持官方 2.1.1 和现有阅读页。
- Kutt 官方 3.2.6：上游 digest `sha256:0ddd5ee76e211c4e95f5cb8858157dd282a351a8aa1b7222eb20226ce68eae05`，离线导入后的本地标签 `kutt:3.2.6-pinned`，镜像配置 digest `sha256:2fefb34076ad2f1c456cedccabe4dff2086aecf781d4429bfe0c8a5a25822dc6`。Docker save/load 不保留仅按 digest 引用的 RepoDigest，因此使用本地固定标签并记录配置 digest。
- Caddy 2.10.2 Alpine：上游 digest `sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d`，镜像配置 digest `sha256:aac61abc4024c323602ccb9ee38bd68b147601f518626b2a055e06944e01c510`。
- PrivateBin 离线导入后的镜像配置 digest `sha256:21e8e4273e6e5d99b57b1b794f7456cdcc37367a7dd1be73051445b1d1c5f9b0`；`privatebin-start.sh` 只在降权前修正本机 Docker 日志管道属主，解决 PHP-FPM 无权重开 stderr 的问题，不改变阅读页和加密实现。
- Compose 使用 `pull_policy: never`，不在启动时更新镜像。仅网关公开 80/443，应用端口不公开。
- PrivateBin / Kutt / 网关内存上限分别 320 / 384 / 128 MiB。这是故障隔离上限，不是预分配内存。
- 现有容器和服务保持运行，迁移期间不重启 Docker daemon。

## 数据与一致性

1. 先备份 Railway 原始变量（保存在本机 `.auth/`），导出当前运行配置。
2. Kutt 使用 SQLite 在线备份接口，不能直接复制正在写入的数据库。
3. 初次 PrivateBin 数据和 Kutt 快照先恢复到新环境，隔离公网写入，验证文件、数据结构和服务健康。
4. 正式切换时短暂停写旧服务，再做最终数据复制，避免切换窗口创建的新内容遗漏。PrivateBin 的阅后即焚读取也会修改数据，停写阶段应限制所有旧服务请求。
5. 保留 JWT secret、API key 和管理员数据；生成 `kutt.env` 时排除所有 Railway 平台自动变量。
6. DNS 改为目标服务器；验证 TLS、旧短链跳转与普通历史粘贴解密，不读取会被销毁的历史粘贴。
7. 验收用单独测试内容，完成后清理测试数据。

## 回退与计费

- Railway 应用切换完成后停止计算实例，但保留服务配置和数据卷，不删除项目。
- DNS 回退前必须核对新服务器是否接收了新数据，先同步新增数据，不能只改 DNS 造成内容丢失。
- 保留的 Railway 卷仍会产生少量存储费；数据备份确认后再决定是否永久删除。
- 当前目标服务器 2 GB 内存，两个应用预计增加约 400 MiB，另加网关开销；验收需观察实际内存和 swap。
- 中国大陆主机公开提供网站前需核对域名备案和阿里云接入限制，避免直接切换后被拦截。

## 已确认的线上变更范围

用户已确认：下载缺失的两个固定版本镜像、新增三个容器和数据目录、开放 80/443（若云防火墙尚未放行）、获取 HTTPS 证书、复制私有数据、短暂停服务、切换两个域名、停用 Railway 两个计算实例；保留原数据卷用于回退。
