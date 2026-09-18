# PostgreSQL

项目支持通过同一个 `docker compose` 项目运行应用和 PostgreSQL。数据库与应用保持为两个容器，避免应用重建或回滚时影响数据库数据。

## 配置

`.env` 至少需要：

```dotenv
POSTGRES_DB=video_pipeline
POSTGRES_USER=video_pipeline
POSTGRES_PASSWORD=<strong-password>
POSTGRES_PORT=55432
DATABASE_URL=postgresql://video_pipeline:<strong-password>@postgres:5432/video_pipeline
PIPELINE_DB_PATH=postgresql://video_pipeline:<strong-password>@postgres:5432/video_pipeline
POSTGRES_POOL_SIZE=10
```

容器内连接必须使用 Compose 服务名 `postgres:5432`。宿主机执行迁移和检查时，改用 `127.0.0.1:${POSTGRES_PORT}`。

## 初始化

```bash
docker compose up -d postgres
docker compose ps postgres
```

`postgres/schema.sql` 会由迁移命令自动应用。数据保存在 `postgres-data` named volume 中。

## 从 SQLite 迁移

先停止写入 SQLite 的应用，再创建一致性备份：

```bash
docker compose stop video-pipeline-gpu
```

SQLite 备份应使用 BetterSQLite3 Backup API，不要直接复制仍在写入的 WAL 数据库。然后执行：

```bash
npm run db:migrate:postgres -- \
  --sqlite work/migration/pipeline-final.sqlite3 \
  --postgres-url "postgresql://video_pipeline:<strong-password>@127.0.0.1:55432/video_pipeline" \
  --reset
```

迁移器会：

- 应用 PostgreSQL schema
- 在一个事务中迁移全部业务表
- 重置 identity sequence
- 比较每张表的 SQLite/PostgreSQL 行数

迁移成功后，将 `PIPELINE_DB_PATH` 切换为容器内 PostgreSQL URL，再启动应用：

```bash
docker compose up -d --no-deps --force-recreate --no-build video-pipeline-gpu
docker compose ps video-pipeline-gpu postgres
```

## 验证

```bash
docker compose logs --tail 200 video-pipeline-gpu
docker compose exec postgres pg_isready -U video_pipeline -d video_pipeline
```

还应检查：

- `videos`、`video_parts`、`pipeline_events` 等表行数与 SQLite 一致
- 最新视频、待总结和待发布状态一致
- 调度器能读取 PostgreSQL，且没有 SQLite lock 报错
- 评论发布队列保持单并发

## 回滚

迁移期间保留：

- 原始 `work/pipeline.sqlite3`
- 最终一致性 SQLite 备份
- 切换前的 GPU 镜像 tag

如果新服务验证失败，停止新服务，将 `PIPELINE_DB_PATH` 改回 SQLite 路径，恢复旧镜像 tag 后重新启动。不要删除 PostgreSQL volume，便于排查和再次切换。
