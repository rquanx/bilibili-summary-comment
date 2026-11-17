# 2026-11-15 迁回 Railway

用户确认 `voxwing.top` 未备案，并明确授权迁回 Railway，保留域名及数据；停用阿里云新增的三个容器。不改动 Postgres、其他阿里云容器、GPU 流水线或 B 站评论。

## 数据同步

- 阿里云最新在线初始快照、停写后的最终快照、Railway 覆盖前快照均保存到本机忽略目录 `.auth/railway-return-20261115/`。
- Kutt 初始快照通过 better-sqlite3 在线备份接口生成；最终快照在网关和两个应用停止后复制，SQLite `integrity_check` 为 `ok`，含 1 个管理员和 1 条短链。
- PrivateBin 最终包含 20 个文件（16 条加密粘贴及辅助文件）。恢复前暂停 Railway Nginx/PHP-FPM，并冻结 Kutt Node 进程；备份原卷后同步最终快照。
- 全部 PrivateBin 文件 SHA-256 清单与最终源快照完全一致，恢复后的 Kutt 数据库 SHA-256 与最终源快照完全一致。
- 恢复 PrivateBin 后重新启动进程；Kutt 数据库原子替换后重启部署，使 SQLite 重新打开新文件。
- 私有快照含账号数据及完整 PrivateBin 链接密钥，不得提交或公开。

## Railway

- PrivateBin 当前部署：`5e4cf344-ca2b-4a27-9a2e-2e1b14bdfd44`，原镜像重新部署，无依赖更新。
- Kutt 当前部署：`5dc21a37-1cd7-489d-9b52-066b8b5ed428`，直接 `deploymentRestart` 恢复原成功部署。
- Kutt 最初通过 CLI redeploy 创建的 `07568db0-25e9-4563-b72a-df62addcb45a` 未产生实例且失败；它不是当前运行实例。
- 当前两个部署均确认 `SUCCESS`、`deploymentStopped: false`、实例 `RUNNING`。

## DNS 与过渡

- `privatebin.tool.voxwing.top` 恢复 DNS-only CNAME → `blad7nw4.up.railway.app`。
- `s.voxwing.top` 恢复 DNS-only CNAME → `w0auguip.up.railway.app`。
- TTL 自动（300 秒），原 Railway 认证 TXT 保留；原 Railway 自定义域名证书仍有效。
- 阿里云应用停止后，Caddy 临时使用 `Caddyfile.return-bridge` 将旧 IP 请求转发到 Railway；显式保留用户域名的 Host 与 TLS SNI。Railway 的 CNAME 接入目标不能直接用作 HTTP Host，否则返回 Application not found。
- 缓存期后停止阿里云网关，保留容器、镜像、证书和数据备份，不删除其他服务。

## 验收

- 运行中的 GPU 容器通过公共 HTTPS 完成 PrivateBin 加密创建、读取解密、Kutt API key 认证、短链创建、302 跳转和匿名创建拒绝验证；验收数据已删除。
- 浏览器通过历史短链进入对应 PrivateBin，解密完成，新版阅读页的字号调整和复制全文控件正常显示。
- 域名、管理员及 API key 保持不变，流水线无需修改。
- 最终已停止阿里云 `voxwing-paste-privatebin-1`、`voxwing-paste-kutt-1`、`voxwing-paste-gateway-1` 三个容器；原录播与 RustDesk 容器继续运行。
- 在阿里云网关停止之后，GPU 容器再次通过公共域名完成全部新建/读取/解密/短链验收并清理测试数据，确认正常访问不再依赖阿里云。
- Cloudflare 权威 DNS、1.1.1.1 和 8.8.8.8 均已确认解析至 Railway CNAME/地址。
- 阿里云最终快照另保存到 `/opt/voxwing-paste/backups/privatebin-final.tar.gz` 和 `kutt-final.sqlite`，保留目录与镜像作为备份。
