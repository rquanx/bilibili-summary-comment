# PrivateBin / Pastebin

2026-11-18 通过 Railway CLI 核实：当前部署 `443667b4-d540-4396-b3e4-ebd9a5821312`，`SUCCESS`、`deploymentStopped=false`，实例 `RUNNING`。

| 配置 | 当前值 |
| --- | --- |
| 项目 / 环境 | summary-paste / production，ID 见[部署索引](../README.md) |
| 服务 ID | `34b87437-c322-4f07-98ba-9148cf138a73` |
| 公开入口 | https://pastebin.tool.voxwing.top/ |
| 兼容入口 | https://privatebin.tool.voxwing.top/ ，308 跳转到公开入口 |
| 端口 / 健康检查 | 8080 / `/`，超时 60 秒 |
| 存储卷 | `privatebin-volume`，挂载 `/srv/data`，当前状态 READY |
| 上游 | PrivateBin 2.1.1，Dockerfile 固定镜像 digest |

## 目录与运行配置

- `Dockerfile`、`start.sh`：复用上游镜像，在降权启动前修正存储权限；Nginx 固定一个 worker。
- `conf.php`：中文默认、10 MiB 上限、文件存储、每来源 IP 创建间隔 10 秒。页面默认一周过期，可选择永久及阅后即焚。
- `reader/`：正式阅读页模板、样式和脚本。正文默认 17px、最大宽度 920px，提供字号调整和复制全文；解密期间隐藏旧界面，保留密码及错误提示。
- `patch-reader-core.php`：只扩展上游分享链接的阅读模式后缀，不替换加密与存储流程。
- `legacy-domain.conf`：旧域名跳转，保留路径和 query；解密 fragment 由浏览器继承。
- `local-preview/`：完整服务的[本地预览说明](local-preview/README.md)，与线上共用正式阅读资源。

## 流水线接入

`src/domains/bili/paste-upload.ts` 使用 PrivateBin v2：PBKDF2-SHA256、AES-256-GCM、随机密钥/IV/salt、无压缩，上传永久且非阅后即焚的粘贴。配置：

```dotenv
PRIVATEBIN_URL=https://pastebin.tool.voxwing.top/
PRIVATEBIN_LEGACY_URLS=https://privatebin.tool.voxwing.top/
```

完整分享链接必须保留 `#` 后的密钥；`&view=reader` 使用新版阅读页，`&view=original` 或没有后缀使用原版。密钥 fragment 不发送给 PrivateBin；若启用短链，完整链接会保存在受认证保护的短链映射中。

上传限速默认 11 秒，沿用 `PASTE_RS_MIN_INTERVAL_MS` 配置及锁文件名。超时后不自动重复创建；失败记录提供 `src/commands/paste-upload.ts` 加密重试命令。历史 paste.rs、配置中的旧域名和旧 MicroBin 链接保留识别兼容，不需要运行旧服务部署配置。

## 构建与维护

本目录作为独立构建上下文。依赖、上游基础镜像不变时复用本地镜像与缓存，以 `--pull=false --network=none` 构建；不更新系统包或重拉模型。不要上传仓库根目录、`.env`、`.auth` 或工作文件。

发布前备份数据卷并单独确认影响范围。Railway 保留的历史部署用于按需回退，回退前须核对数据兼容和新产生的数据；历史部署 SUCCESS 不代表它仍在运行。
