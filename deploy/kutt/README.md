# 通用短链服务 Kutt

> 已于 2026-11-15 替换为 Chhoto URL，入口和旧短链保留。以下内容作为 Kutt 历史部署与回退记录；当前部署见 [Chhoto URL](../chhoto-url/README.md)。原 Kutt 容器已停止，数据库保留。

> 2026-11-15：已迁回 Railway 并完成启动进程优化，当前运行部署 `bf0f0969-b15b-4d4d-ac63-6a2a3ec1375b`。迁回记录见 `../aliyun-paste/RETURN-TO-RAILWAY.md`。

## 内存优化（2026-11-15）

基于同一固定官方镜像，仅增加 `start.sh`：先直接执行 Knex 的 `migrate:latest`，再 `exec node server/server.js --production`。保留上游 entrypoint、数据库迁移和启动参数，去掉常驻 `npm start` 进程；无依赖安装或升级。

更新后部署状态 SUCCESS、实例 RUNNING，PID 1 为应用 Node 进程，迁移日志为 Already up to date。Railway 分钟指标从约 0.167 GB 降至 0.152 GB（短时样本，非长期均值）。已有 API Key 创建短链、302 跳转、禁止匿名创建及测试数据清理通过。回退部署为 `5dc21a37-1cd7-489d-9b52-066b8b5ed428`；保留原 SQLite 数据卷。优化前在线数据库备份及指标保存在本机忽略目录 `.auth/memory-optimization-20261115/`。

入口：https://s.voxwing.top/ ，管理员登录：https://s.voxwing.top/login 。

## 部署

- Railway project: summary-paste / 66f48039-c31f-4cfd-92c9-993d85ff2d04
- Environment: production / 8772c5e3-983c-471a-ae81-c22cd8152f3b
- Service: kutt / a2f6187c-cf58-4f86-b9e1-e55c70025ce3
- Volume: kutt-volume / 909bf1be-f0db-4def-b238-1119c82fc6d7，挂载 /var/lib/kutt
- 官方 Kutt v3.2.6，amd64 digest: sha256:0ddd5ee76e211c4e95f5cb8858157dd282a351a8aa1b7222eb20226ce68eae05
- SQLite: /var/lib/kutt/data.sqlite；单副本，端口 3000，健康检查 /api/v2/health。
- 不依赖 Redis、不发送邮件；关闭公开注册与匿名创建；访问短链无需登录。
- 网页随机短码默认 6 位；支持自定义短码、过期时间、密码与访问统计。

配置保存在 Railway 变量中。JWT_SECRET 由密码学随机数生成；管理员在开放 DNS 之前创建。管理员登录凭据在本机忽略目录 `.auth/kutt-admin-login.txt`，API Key 和 JWT secret 在 `.auth/kutt-secrets.json`；不要提交、上传或打印这些文件。

Cloudflare 添加 DNS-only CNAME s -> w0auguip.up.railway.app；所有权 TXT 位于 _railway-verify.s。TLS 由 Railway 签发。

本文件夹是独立部署根，不得上传仓库根目录或 .env / .auth。Dockerfile 只引用固定官方镜像，无依赖安装和更新。重新部署：

```powershell
railway link -p 66f48039-c31f-4cfd-92c9-993d85ff2d04 -e production -s a2f6187c-cf58-4f86-b9e1-e55c70025ce3
railway api --file service-settings.graphql --variables "@service-settings.json"
railway up --detach --path-as-root .
```

## 流水线接入

本机 `.env` 设置 KUTT_URL=https://s.voxwing.top/ 和 KUTT_API_KEY（不在文档中记录值）。流水线先按原逻辑创建永不过期、非阅后即焚的 PrivateBin，生成包含完整密钥及 &view=reader 的地址，再调用 POST /api/v2/links。

`src/domains/bili/short-link.ts` 只负责 Kutt；密文上传仍由 paste-upload.ts 负责。自动化请求携带 X-API-Key，启用 reuse，并使用完整目标 URL 的 SHA-256 前 10 个十六进制字符作为固定短码；相同目标可恢复已接受的请求，避免创建重复短链。返回值必须指向配置的短链域名且保留完整目标。无自动 POST 重试；超时或错误保留可用的原始 PrivateBin 地址，错误日志不含密钥或响应正文。短码冲突也会安全回退原地址。

识别逻辑同时兼容 s.voxwing.top、旧 PrivateBin、paste.rs 与历史 MicroBin。仅未来新创建的摘要链接经过短链服务，旧评论不修改。常规用户可以用网页创建任何合法目标 URL 的短链。

PrivateBin 完整链接（包括解密密钥）会保存在 Kutt 数据库中；该数据卷与备份按私有数据保管。数据库备份应使用 SQLite 在线备份接口，再下载备份文件，避免复制正在写入的数据库。

## 验证与回滚

本地相关测试 34 项通过、3 项原有跳过；实际 GPU 部署镜像内的 9 项上传及短链测试全部通过。已验证通用链接 API、302 跳转、匿名创建被拒绝、管理员网页登录，以及运行中 GPU 上传后通过短链打开新版阅读页。

GPU 镜像基于切换前运行镜像离线增量构建，只变更 paste-upload.ts、paste-links.ts，新增 short-link.ts。部署镜像 video-pipeline:gpu-kutt-ready，digest sha256:8a77c0f4cc0436779716f2da3c29955beabefc8de8dbdbedeb9b2b9d67edbc8a。旧镜像保留为 video-pipeline:gpu-before-kutt / video-pipeline:gpu-rollback。环境备份在 .auth/env-before-kutt-20261114.env。

回滚流水线时恢复环境备份与旧镜像，仅重建 GPU 服务。Kutt 数据卷须保留，已有短链依赖它，不能随回滚删除。

Railway 服务设置通过原生 API 保存（service-settings.graphql / service-settings.json），不依赖即将废弃的 railway.json。已验证重新部署后管理员与短链仍存在，验收短链及对应 PrivateBin 内容已清理。

当前已验证成功的 Railway 重部署：5dc21a37-1cd7-489d-9b52-066b8b5ed428。
