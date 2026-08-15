# 项目协作规则

## 镜像构建

- 构建 Docker 镜像时，除非依赖、基础镜像或系统组件确实发生变化，否则禁止联网下载或更新依赖。
- 优先复用本地基础镜像、现有镜像层和 BuildKit 缓存，并使用 `--pull=false`。
- 仅修改业务代码时，优先基于现有镜像进行增量构建，只覆盖发生变化的文件；可使用 `--network=none` 明确禁止构建阶段联网。
- 仅修改 `src` 业务代码并替换 GPU 容器时，默认使用 `Dockerfile.gpu.incremental`，不要直接构建 `Dockerfile.gpu`，也不要使用临时容器配合 `docker cp` / `docker commit`。标准流程：

  ```bash
  docker build --pull=false --network=none \
    -f Dockerfile.gpu.incremental \
    --build-arg BASE_IMAGE=video-pipeline:gpu \
    -t video-pipeline:gpu-next .
  docker tag video-pipeline:gpu video-pipeline:gpu-rollback
  docker tag video-pipeline:gpu-next video-pipeline:gpu
  docker compose up -d --no-deps --force-recreate --no-build video-pipeline-gpu
  docker compose ps video-pipeline-gpu
  ```

- 增量构建必须使用本地镜像名作为 `BASE_IMAGE`。不要在增量 Dockerfile 中直接引用远程 CUDA 基础镜像，否则 BuildKit 即使带有 `--pull=false`，仍可能联网读取远程 manifest 元数据。
- 仅当 `package.json`、`package-lock.json`、`requirements.txt`、`Dockerfile.gpu`、基础镜像或系统依赖发生变化时，才允许改用完整 GPU 镜像构建流程。
- 不得仅为获取最新版本而执行 `apt update`、`npm update`、`pip install --upgrade`、重新拉取模型或其他依赖更新操作。
- 必须联网或更新依赖时，先说明原因、下载内容、缓存失效范围及对构建时间和镜像的影响，等待确认后再执行。
