# Setup

这份文档只讲一件事：把项目在一台新机器上跑起来，并确认首轮流水线与调度都工作正常。

## 前置要求

- Node.js `24` 或更高版本
- npm
- Python `3.11` 或更高版本
- `ffmpeg` 在 `PATH` 中可用

说明：

- 项目依赖 Node 内置的 `node:sqlite`
- 在 Node 24 上可用，但可能仍会打印 experimental warning

## 一键初始化

### Windows

```powershell
npm run setup:ps
```

可选参数：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup/setup-env.ps1 -VenvPath .3.11 -PreferredPython 3.11
```

也支持跳过其中一段：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup/setup-env.ps1 -SkipNode
powershell -ExecutionPolicy Bypass -File scripts/setup/setup-env.ps1 -SkipPython
```

### macOS / Linux

```bash
npm run setup:sh
```

可选环境变量：

```bash
VENV_PATH=.3.11 PREFERRED_PYTHON=python3.11 bash ./scripts/setup/setup-env.sh
```

也支持跳过其中一段：

```bash
SKIP_NODE=1 bash ./scripts/setup/setup-env.sh
SKIP_PYTHON=1 bash ./scripts/setup/setup-env.sh
```

## 初始化脚本会做什么

- 安装 Node 依赖
- 创建 Python 虚拟环境
- 安装 `requirements.txt` 中的 `videocaptioner` 与 `yt-dlp`
- 检查 `python -m yt_dlp` 和 `python -m videocaptioner` 是否可用
- 检查 `ffmpeg` 是否存在

如果最后只看到 `ffmpeg` 警告，通常说明 Node / Python 依赖已经装好了，只是转写阶段还不能跑。

## 配置 `.env`

CLI 脚本默认会自动加载仓库根目录 `.env`。最小可用配置通常是：

```dotenv
SUMMARY_API_KEY=your_api_key
SUMMARY_MODEL=gpt-4o-mini
SUMMARY_USERS=https://space.bilibili.com/123456
CRON_TIMEZONE=Asia/Shanghai
```

总结接口相关变量：

- `SUMMARY_API_KEY` 或 `OPENAI_API_KEY`
- `SUMMARY_API_BASE_URL` 或 `OPENAI_BASE_URL`
- `SUMMARY_MODEL` 或 `OPENAI_MODEL`
- `SUMMARY_API_FORMAT` 或 `OPENAI_API_FORMAT`

支持的 `SUMMARY_API_FORMAT`：

- `auto`
- `responses`
- `openai-chat`
- `anthropic-messages`

OpenCode Go 示例：

```dotenv
SUMMARY_API_KEY=your_opencode_go_key
SUMMARY_API_BASE_URL=https://opencode.ai/zen/go/v1
SUMMARY_API_FORMAT=openai-chat
SUMMARY_MODEL=glm-5
```

调度相关变量：

- `SUMMARY_USERS`
- `SUMMARY_SINCE_HOURS`
- `SUMMARY_PIPELINE_CONCURRENCY`
- `BILI_COOKIE_FILE`
- `BILI_AUTH_FILE`
- `BILI_REFRESH_DAYS`
- `WORK_CLEANUP_DAYS`
- `PIPELINE_DB_PATH`
- `WORK_ROOT`
- `CRON_TIMEZONE`
- `SERVER_CHAN_SEND_KEY`

默认路径与默认值：

- `BILI_COOKIE_FILE` 默认 `cookie.txt`
- `BILI_AUTH_FILE` 默认 `bili-auth.json`
- `PIPELINE_DB_PATH` 默认 `work/pipeline.sqlite3`
- `WORK_ROOT` 默认 `work`
- `SUMMARY_SINCE_HOURS` 默认 `24`
- `SUMMARY_PIPELINE_CONCURRENCY` 默认 `3`
- `BILI_REFRESH_DAYS` 默认 `30`
- `WORK_CLEANUP_DAYS` 默认 `2`

## 初始化 Bilibili 登录

先跑：

```bash
npm run login:bili
```

命令会输出二维码 URL。扫码成功后，默认会写入：

- `bili-auth.json`
- `cookie.txt`

如果你想把这两个文件放到别处，也可以在命令里显式传：

```bash
tsx scripts/commands/login-bili-tv.ts --auth-file ./secrets/bili-auth.json --cookie-file ./secrets/cookie.txt
```

## 首次验证

### 1. 同步一条视频

```bash
npm run sync:video -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx
```

这一步只验证：

- cookie 是否有效
- 视频详情和分 P 是否能拉到
- SQLite 是否能正常写入

### 2. 跑完整流水线

只生成字幕和总结：

```bash
npm run pipeline -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx
```

生成后直接发布：

```bash
npm run pipeline -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --publish
```

常见附加参数：

```bash
npm run pipeline -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --force-summary
npm run pipeline -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --asr bijian
npm run pipeline -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --venv-path .3.11
```

### 3. 检查输出目录

默认会生成：

```text
work/<BV号>/
  cid-<cid>.srt
  cid-<cid>.m4a
  summary-p01.md
  summary.md
  pending-summary.md
```

同时数据库默认位于：

```text
work/pipeline.sqlite3
```

### 4. 检查事件日志

```bash
npm run inspect:events -- --since-hours 24 --limit 100
```

这条命令会从 `pipeline_events` 表里汇总最近的流水线事件、待处理分 P 和发布模式统计。

## 批量扫描与定时调度

手工扫描 `SUMMARY_USERS` 最近投稿：

```bash
npm run sync:users
```

说明：

- 该命令当前默认会执行完整流水线并自动发布
- 同一 UP、同一场录播的不同标题变体会被串行处理，避免总结和评论线程互相覆盖

启动常驻调度：

```bash
npm run schedule
```

启动前先立即跑一轮：

```bash
npm run start
```

只执行一次并退出：

```bash
tsx scripts/commands/run-scheduler.ts --once summary
tsx scripts/commands/run-scheduler.ts --once refresh
tsx scripts/commands/run-scheduler.ts --once cleanup
tsx scripts/commands/run-scheduler.ts --once all
```

调度详情见 [SCHEDULE.md](./SCHEDULE.md)。

## 打包与测试

构建 `dist`：

```bash
npm run build
```

说明：

- 构建时会编译 TypeScript 到 `dist/`
- 如果仓库根目录存在 `.env`、`cookie.txt`、`bili-auth.json`、`work/pipeline.sqlite3`、`sql/`，构建脚本会一并复制到 `dist/`
- 调度器在 `dist` 环境下会优先直接执行编译后的 `scripts/commands/run-video-pipeline.js`

运行测试与类型检查：

```bash
npm test
npm run typecheck
```

## 常见问题

### 1. 提示缺少 API key

补齐以下任意一组变量即可：

- `SUMMARY_API_KEY` + `SUMMARY_MODEL`
- `OPENAI_API_KEY` + `OPENAI_MODEL`

### 2. 能同步视频，但转写失败

优先检查：

- `ffmpeg` 是否在 `PATH`
- Python 虚拟环境是否正确创建
- `videocaptioner`、`yt-dlp` 是否安装成功

默认 ASR 是 `faster-whisper`，失败后会自动回退到 `bijian`、`jianying`。

### 3. 调度能启动，但不会扫描任何视频

优先检查：

- `SUMMARY_USERS` 是否配置
- `SUMMARY_SINCE_HOURS` 是否过小
- `cookie.txt` 是否有效

### 4. 刷新 cookie 失败

确认以下文件是否存在且内容完整：

- `bili-auth.json`
- `cookie.txt`

如果 `bili-auth.json` 不存在，可以重新执行一次 `npm run login:bili`。
