# Docker

这个项目可以直接以容器方式运行，业务代码和依赖打进镜像，`work`、`.auth` 挂载到宿主机。

## 目录映射

- 宿主机 `./work` -> 容器 `/app/work`
- 宿主机 `./.auth` -> 容器 `/app/.auth`

默认环境变量已经对齐：

- `WORK_ROOT=work`
- `PIPELINE_DB_PATH=work/pipeline.sqlite3`
- `BILI_AUTH_FILE=.auth/bili-auth.json`

## 使用 docker compose

构建镜像：

```bash
docker compose build
```

首次登录 Bilibili：

```bash
docker compose run --rm video-pipeline npm run login:bili
```

跑单条视频：

```bash
docker compose run --rm video-pipeline npm run pipeline -- --bvid BVxxxxxxxxxx --publish
```

启动常驻调度：

```bash
docker compose up -d
```

查看日志：

```bash
docker compose logs -f video-pipeline
```

## 使用 docker run

先构建镜像：

```bash
docker build -t video-pipeline:local .
```

启动调度器：

```bash
docker run -d \
  --name video-pipeline \
  --env-file .env \
  -e CRON_TIMEZONE=Asia/Shanghai \
  -v "${PWD}/work:/app/work" \
  -v "${PWD}/.auth:/app/.auth" \
  video-pipeline:local
```

执行一次登录：

```bash
docker run --rm -it \
  --env-file .env \
  -v "${PWD}/work:/app/work" \
  -v "${PWD}/.auth:/app/.auth" \
  video-pipeline:local \
  npm run login:bili
```

## 说明

- 镜像内已安装 Node 24、Python 3、`ffmpeg`、`videocaptioner`、`yt-dlp`
- `.env` 不会打进镜像，运行时通过 `--env-file .env` 或 `docker-compose.yml` 的 `env_file` 注入
- 如果你只想执行单次命令，用 `docker compose run --rm video-pipeline ...`
