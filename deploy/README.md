# Railway 部署目录

2026-11-18 通过 Railway CLI 只读查询 `summary-paste/production` 核实：仅有以下两个服务，均为 `SUCCESS`、`deploymentStopped=false`，实例为 `RUNNING`。

| 目录 | 实际应用 | Railway 服务名 | 公开入口 | 当前部署 |
| --- | --- | --- | --- | --- |
| [privatebin](privatebin/README.md) | PrivateBin 2.1.1 | privatebin | https://pastebin.tool.voxwing.top/ | `443667b4-d540-4396-b3e4-ebd9a5821312` |
| [chhoto-url](chhoto-url/README.md) | Chhoto URL 7.11.4 | kutt（历史名称） | https://s.voxwing.top/ | `f3f1553a-ef33-4686-b399-55b7091d31f9` |

项目 ID：`66f48039-c31f-4cfd-92c9-993d85ff2d04`；生产环境 ID：`8772c5e3-983c-471a-ae81-c22cd8152f3b`。

复核命令（只读）：

```bash
railway status --project 66f48039-c31f-4cfd-92c9-993d85ff2d04 --environment production --json
```

`kutt` 服务及 `/var/lib/kutt` 卷名沿用旧名称，当前应用已替换为 Chhoto；不能按服务名称误判为旧 Kutt 仍在运行。

部署目录只保留现用服务。旧 Kutt、MicroBin、阿里云迁移配置、一次性 Kutt 迁移脚本及独立阅读页原型已移出版本管理，本地副本保存在忽略目录 `temp/retired-deploy-20261118/`。PrivateBin 的 `reader/` 是正式阅读页，`local-preview/` 复用同一份资源进行本地验证。

每个服务使用自己的子目录作为构建上下文，不上传仓库根目录、密钥或运行数据。部署、迁移及验收写入均需重新说明影响并确认；此次整理只查询线上状态，没有部署、重启或修改线上数据。
