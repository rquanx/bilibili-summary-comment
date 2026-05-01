# Docker

这个项目可以直接以容器方式运行，业务代码和依赖打进镜像，`work`、`.auth` 挂载到宿主机。

如果你要让容器里的 ASR 尽量贴近本机 VideoCaptioner，仓库现在额外提供了 `video-pipeline-gpu` 服务：

- 基于 `nvidia/cuda` + `cudnn` 运行时镜像
- 镜像内预装 Linux 版 `Faster-Whisper-XXL`
- 默认对齐 `large-v3-turbo`、`cuda`、`silero-v4`、`0.4`
- 可以直接复用你 Windows 本机已下载的模型目录

## 目录映射

- 宿主机 `./work` -> 容器 `/app/work`
- 宿主机 `./.auth` -> 容器 `/app/.auth`

默认环境变量已经对齐：

- `WORK_ROOT=work`
- `PIPELINE_DB_PATH=work/pipeline.sqlite3`
- `BILI_AUTH_FILE=.auth/bili-auth.json`

GPU 服务额外会使用：

- `VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_BIN=/opt/videocaptioner/bin/Faster-Whisper-XXL`
- `VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_MODEL_PATH=/opt/videocaptioner/models/faster-whisper-large-v3-turbo`
- `VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_DEVICE=cuda`
- `VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_VAD_METHOD=silero-v4`
- `VIDEOCAPTIONER_LOCAL_FASTER_WHISPER_VAD_THRESHOLD=0.4`

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

## 使用 docker compose 跑本地 CUDA ASR

先确认 Docker 已经能看到 NVIDIA runtime。你这台机器当前满足这一点。

### 1. 直接复用本机 VideoCaptioner 的模型目录

在 `.env` 里增加：

```dotenv
VIDEOCAPTIONER_HOST_MODEL_ROOT=C:/Users/<your-user>/AppData/Local/VideoCaptioner/AppData/models
```

这个目录下面应该已经有：

```text
faster-whisper-large-v3-turbo/
```

如果你不想复用系统目录，也可以不配这项，默认会挂载仓库里的 `./.videocaptioner/models`。

### 2. 构建 GPU 镜像

```bash
docker compose build video-pipeline-gpu
```

### 3. 先单独验证 FasterWhisper

跑单条视频：

```bash
docker compose run --rm video-pipeline-gpu npm run pipeline -- --bvid BVxxxxxxxxxx --asr faster-whisper
```

如果要连总结和发布一起跑：

```bash
docker compose run --rm video-pipeline-gpu npm run pipeline -- --bvid BVxxxxxxxxxx --asr faster-whisper --publish
```

启动常驻调度：

```bash
docker compose up -d video-pipeline-gpu
```

查看 GPU 服务日志：

```bash
docker compose logs -f video-pipeline-gpu
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
- `video-pipeline-gpu` 镜像额外内置了 Linux 版 `Faster-Whisper-XXL`
- `.env` 不会打进镜像，运行时通过 `--env-file .env` 或 `docker-compose.yml` 的 `env_file` 注入
- 如果你只想执行单次命令，用 `docker compose run --rm video-pipeline ...`
- Windows 本机的 `faster-whisper-xxl.exe` 不能直接在 Linux 容器里跑；GPU 服务走的是 Linux 版二进制，但可以复用同一份模型文件
