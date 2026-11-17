# PrivateBin on Railway

> 已上线（2026-11-15）：公开入口为 `https://pastebin.tool.voxwing.top/`，Railway 当前部署 `443667b4-d540-4396-b3e4-ebd9a5821312`（SUCCESS / RUNNING）；域名切换部署为 `9a3fb443-dc1a-466e-9238-6ffe04da8d5c`。创建页底部整块品牌信息已移除，页面名称和 manifest 为 Pastebin。历史短链已直接指向新域名，旧域名保留 308 兼容。

> 2026-11-15：已迁回 Railway 并完成内存优化，当前运行部署 `edc10465-4df4-4934-9b03-38d9bfb5155f`。迁回记录见 `../aliyun-paste/RETURN-TO-RAILWAY.md`。

## 内存优化（2026-11-15）

Nginx 固定 `worker_processes 1`，避免共享宿主机暴露的 CPU 数量使其启动约 48 个 worker。PHP-FPM、加密逻辑、阅读页及数据卷均保持原配置。构建时执行 `nginx -t` 并清除其以 root 创建的空 PID 文件，避免运行时非特权用户无法启动。

更新后部署状态 SUCCESS、实例 RUNNING。Railway 分钟指标从约 0.208 GB 降至 0.037–0.039 GB（短时样本，非长期均值）。完整加密创建、读取解密、短链跳转及测试数据清理通过。回退部署为 `5e4cf344-ca2b-4a27-9a2e-2e1b14bdfd44`；保留原数据卷。优化前数据备份及指标保存在本机忽略目录 `.auth/memory-optimization-20261115/`。

Public URL: https://pastebin.tool.voxwing.top/

Deployed on 2026-11-14 using the official PrivateBin 2.1.1 amd64 image, pinned in the Dockerfile. This folder is the deployment root; never upload the repository root, `.env`, `.auth` or video artifacts.

## Resources

- Project `summary-paste`: `66f48039-c31f-4cfd-92c9-993d85ff2d04`.
- Environment `production`: `8772c5e3-983c-471a-ae81-c22cd8152f3b`.
- Service `privatebin`: `34b87437-c322-4f07-98ba-9148cf138a73`.
- Volume `privatebin-volume`: `3d71f60c-7a32-4b5b-a4bd-9410f913017d`, mounted at `/srv/data`. Railway defaults to a 5 GB maximum, charging for stored data.
- One replica, port 8080, health check `/` (60 seconds), restart on failure (five retries).
- Cloudflare DNS-only CNAME `privatebin.tool` -> `blad7nw4.up.railway.app`, with ownership TXT at `_railway-verify.privatebin.tool`. Railway supplies the validated TLS certificate.

The startup script gives the mounted directory to upstream's UID 65534 / GID 82 and then drops privileges before starting Nginx and PHP-FPM. The image includes dependencies; builds only copy configuration and the startup script, without package installation or updates.

## User behavior

Chinese is the default language; language and light/dark theme selectors remain available. Users can create pastes without an account or upload password. The optional password protects reading a specific paste; it is not a site upload credential.

Default expiry is one week; users may choose never, or enable burn after reading. Markdown, code highlighting, QR codes, optional discussions and attachments are enabled. Maximum encrypted document size is 10 MiB. The default limit allows one creation per source IP every 10 seconds, using the reverse proxy's forwarded address.

Encryption happens in the browser. Share the complete URL, including its `#` fragment; the server never receives that decryption key. Preserve the deletion link when creating a paste if manual removal may be needed. A normal raw-text server endpoint cannot replace PrivateBin's client-side decryption.

## Validation

Verified the live Chinese UI, never-expiring Chinese paste creation, opening and decrypting the link after a service restart, manual deletion, and burn-after-reading: the first confirmed read displayed the content and the next confirmed read reported that the paste no longer existed. Test pastes were removed.

## Previous service and pipeline

MicroBin service `62a3524e-2692-4c77-978f-d132c0be0b8c` was removed. Its database was empty (`[]`) and a copy was saved under ignored `temp/microbin-retired-database.json`. The old volume was submitted for deletion and is pending Railway's retention window; both MicroBin DNS records were deleted.

The GPU pipeline was switched on 2026-11-14 using the offline incremental Docker build and a restart of only `video-pipeline-gpu`. `.env` sets `PRIVATEBIN_URL=https://privatebin.tool.voxwing.top`. The previous GPU image is retained as `video-pipeline:gpu-rollback`; a private `.env` backup is under ignored `.auth/`.

`src/domains/bili/paste-upload.ts` implements PrivateBin v2 with asynchronous PBKDF2-SHA256, AES-256-GCM, authenticated metadata, random keys/IVs/salts, and no compression or extra dependencies. Summary uploads use never-expiring, non-burning pastes and preserve the base58 key fragment in the public comment. The shared upload limiter defaults to 11 seconds; the historical `PASTE_RS_MIN_INTERVAL_MS` override and lock filenames remain compatible. Upload POSTs are not blindly retried after ambiguous timeouts. Failure artifacts include a command invoking `src/commands/paste-upload.ts` to encrypt before sending; plaintext multipart requests are not supported.

Validation: 99 targeted tests passed, with 3 existing skips. A pipeline-generated Chinese paste was independently decrypted by the live browser UI and then deleted; the API confirmed it no longer existed. A second upload from the running GPU container, through its configured proxy, also succeeded and was deleted with verification. Existing paste.rs and configured legacy MicroBin links remain recognizable. The retired `video-pipeline:gpu-microbin-ready` image must not be rolled out.

## Redeploy

Run `railway link` in this folder using the exact project, environment and service above, then `railway up --detach --path-as-root .`. Changes to only these configuration files reuse the official base image. Do not use the retired `deploy/microbin` instructions.


## 新版阅读页（2026-11-14）

Railway deployment: `0e406a6d-8b70-490c-b7fa-d5cf4e1f5080`（SUCCESS）。模板及样式统一存放在 `reader/`；本地预览通过只读挂载复用同一份文件。创建页沿用官方界面，只增加阅读样式选择，默认新版。

新版正文最大宽度 920px、默认字号 17px、行高 1.55、条目上下内边距 5px；只提供字号调整和复制全文，无返回原始阅读页按钮。Markdown 继续使用官方视图。

分享链接在密钥后追加 `&view=reader`，创建成功提示、复制链接、浏览器地址和二维码采用同一个链接。原版链接使用 `&view=original`；没有样式后缀的旧链接保持原版。原生密钥解析忽略 `&` 后内容，服务器不接收 fragment。`patch-reader-core.php` 在构建时只改链接生成这一处，并检查目标只匹配一次；加密、提交、解密和存储都沿用官方实现。

流水线上传函数也固定生成 `&view=reader` 链接，识别模块同时兼容新后缀和旧链接。GPU 镜像 `video-pipeline:gpu` 为 `sha256:8e43c05eed0cee45f86f14bd07d1c7e0c4584e37978d9c1977efe1a7185eae1b`；以运行中的旧镜像为基础，仅替换 `paste-upload.ts` 和 `paste-links.ts`，未夹带工作区其他未部署修改。旧镜像保留在 `video-pipeline:gpu-rollback`。

验收：相关本地测试 30 项通过、3 项既有跳过；实际部署镜像内的 5 项上传/链接测试全部通过。线上官方创建页和运行中 GPU 容器分别创建测试内容，新版浏览器解密正常；两条验收粘贴已删除。保留原有数据卷，未修改已有评论或历史链接。

## Pastebin 域名切换（已上线 2026-11-15）

- 新公开入口：`https://pastebin.tool.voxwing.top/`，名称 Pastebin，创建页不再输出底部 footer；原始和新版阅读方式继续可用，正文仍为 17px。
- Railway 原服务、数据卷及数据不迁移；新增域名绑定和 Cloudflare DNS-only CNAME（及 Railway 要求的验证 TXT），原域名继续绑定。
- `legacy-domain.conf` 单独匹配旧域名，以 308 跳到新域名并原样保留请求路径、query。Location 不携带 fragment，由浏览器继承原 fragment；解密密钥仍不经过服务器。上线须在新域名 HTTPS 就绪后才启用跳转。
- 已通过认证 Chhoto API 更新 1 条历史短链目标，仅替换旧域名 origin；短码、路径、query、完整密钥 fragment、启停、过期时间、备注均保留。更新前备份并检查目标未被并发修改，更新后 expand 与公开跳转均核对一致；不修改退休 Kutt 数据库。新创建目标也直接使用新域名。
- GPU 环境已改为 `PRIVATEBIN_URL=https://pastebin.tool.voxwing.top/`，并增加 `PRIVATEBIN_LEGACY_URLS=https://privatebin.tool.voxwing.top/`。摘要链接识别同时接受新、旧域名，避免把历史直接链接漏算为未发布内容。
- 应用镜像 `privatebin:pastebin-ready` 和 GPU 增量镜像 `video-pipeline:gpu-pastebin-ready` 均复用现有缓存离线构建，无依赖升级。GPU 从实际运行镜像提取上下文，只替换 `src/domains/summary/paste-links.ts`，不包含工作区其他待部署改动。
- 本地和待部署 GPU 镜像内 15 项相关测试通过；新应用实际创建、阅读显示和删除验收通过，footer DOM 数量为 0，旧域名跳转响应及 query 保留校验通过。
- 本地审阅入口：`http://localhost:4320/`；截图及准备文件位于本机忽略目录 `.auth/pastebin-domain-20261115/`。
- 实际上线范围：新增 DNS/域名，部署 PrivateBin，更新历史短链目标，短暂重启 GPU 流水线。保留旧部署 `edc10465-4df4-4934-9b03-38d9bfb5155f`；GPU 原镜像为 `video-pipeline:gpu-before-pastebin-20261115`，环境及数据备份位于 `.auth/pastebin-domain-20261115/`。未修改已有粘贴正文或 B 站评论。

### 上线验收及回退

- 新域名绑定 ID `266377ef-aa2f-4426-8fbf-630dd4cea5a9`，8080；CNAME `pastebin.tool` → `z6115tyh.up.railway.app`（仅 DNS），验证 TXT `_railway-verify.pastebin.tool`。Railway 证书 VALID、域名 verified。
- 域名切换时的 Railway 部署 `9a3fb443-dc1a-466e-9238-6ffe04da8d5c`，镜像 `sha256:54461b6427ae627fcc1971d58f25ea754796b3b2d90c1739fec36e1482910267`。
- 当前 GPU 镜像 `sha256:66463cd6b120cae4fe2cac9e6231f46fdf2877d0c1b83745bd23bce20161da3f`。暂停 scheduler 后确认无运行中的视频任务，再切换镜像及两个域名环境项，未更新依赖。容器已恢复调度。
- 浏览器创建新版粘贴成功，footer 节点为 0；从旧域名打开同一测试粘贴，浏览器跳转后保留完整 fragment，并正常解密显示。测试粘贴已删除。
- 实际 GPU 容器独立验收通过：加密创建/读回解密、真实流水线短链 API 创建/复用、307 完整密钥保留、匿名请求拒绝、API 鉴权、原管理员密码登录和测试数据清理。公开 HTTPS、标题、17px 阅读 CSS、旧域 308 及 query 保留检查通过。
- 回退需先停止新调度并等当前任务结束，恢复已保存的旧 GPU 镜像与 `.env`；Railway 可重新部署上面的旧部署镜像。若同时取消新域名服务，须利用 `chhoto-before.json` 经认证 API 恢复目标；仅回退页面时新域名仍绑定原服务、数据卷，不需要改目标。备份含解密密钥，禁止公开上传。

## 阅读页首屏闪现修复（已上线 2026-11-15）

`reader-boot.js` 作为同源外部脚本在 head 中同步执行，读取 fragment 的阅读模式并设置 `reader-pending`。CSS 在解密期间隐藏原版导航和主界面，但保留密码弹窗及错误提示；JS 加载失败时退回官方界面。未放宽 CSP，未将 fragment 发往服务器。

`reader.js` 在 MutationObserver 的同一微任务中完成正文重排，不再额外延迟到 requestAnimationFrame；避免重复写入观察范围内相同的 hidden 属性。原始阅读、Markdown 回退、创建页、密码解密和错误提示继续沿用上游逻辑。静态资源版本更新为 `20261115.2`。

本地完整服务验收：正常创建、新版读取、原始读取、密码弹窗/解密及不存在内容的错误提示均通过。在 requestAnimationFrame 逐帧采样中，当前线上旧实现出现 10 帧旧导航及 1 帧旧正文；本地修复后两者均为 0（单次样本，不代表所有网络条件的耗时）。离线增量镜像 `privatebin:reader-flash-ready` 已准备，无依赖升级；预览 `http://127.0.0.1:4320/`。

Railway 部署 `443667b4-d540-4396-b3e4-ebd9a5821312`，SUCCESS / RUNNING，健康检查通过。用户提供的真实链接线上逐帧验证：旧导航和旧正文可见帧数均为 0，新版正文正常显示、pending 解除、字号 17px；创建页阅读选择仍默认新版，footer 为 0。仅更新粘贴服务前端，GPU 流水线未重启。

回退部署 `9a3fb443-dc1a-466e-9238-6ffe04da8d5c`；上线前数据卷备份及验证结果保存在私有目录 `.auth/reader-flash-20261115/`。
