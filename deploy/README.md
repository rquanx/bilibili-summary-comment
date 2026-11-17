# 部署目录索引

此目录保存部署配置、验证脚本及迁移记录。以下状态来自仓库内截至 2026-11-15 的记录，不代表实时线上巡检结果。

| 目录 | 用途 | 状态 |
| --- | --- | --- |
| [privatebin](privatebin/README.md) | 加密内容分享服务、正式阅读页、Docker 配置 | 当前方案，部署在 Railway |
| [chhoto-url](chhoto-url/README.md) | 短链服务及 Kutt 数据迁移工具 | 当前方案，部署在 Railway |
| [kutt](kutt/README.md) | 原短链服务配置 | 历史方案，保留回退材料 |
| [microbin](microbin/README.md) | 原明文分享服务配置 | 已停用，仅供查阅 |
| [aliyun-paste](aliyun-paste/README.md) | 阿里云迁移、网关与迁回 Railway 记录 | 历史方案，保留回退材料 |

PrivateBin 的 `reader/` 是正式阅读页；`local-preview/` 复用正式文件进行完整服务预览；`reader-preview/` 是独立界面原型，不用于生产部署。

各子目录使用自己的构建上下文，不要把仓库根目录、密钥文件、视频或数据库上传为部署包。历史目录保持原路径，以保留文档链接和回退命令。

运行迁移、验收脚本可能创建或删除线上测试数据；文档中的历史确认不授权再次执行。执行前应重新明确影响范围并取得确认。
