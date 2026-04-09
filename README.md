# video-pipeline

一个面向 Bilibili 视频总结与评论发布场景的命令行流水线。

项目目标是把“视频链接 / BV 号 -> 分 P 状态同步 -> 字幕获取 -> 分 P 总结 -> 评论区发布 -> 定时巡检”这条链路尽量固化到代码里，让 LLM 只负责总结正文生成，而不是负责流程编排。

## 当前能力

- 读取 `BV`、`aid` 或视频 URL，并同步视频与分 P 元数据到本地 SQLite
- 优先尝试下载 Bilibili 原生字幕或 AI 字幕，拿不到时再走 `yt-dlp + videocaptioner` 转写
- 为每个分 P 生成独立总结，并产出 `summary-pXX.md`、`summary.md`、`pending-summary.md`
- 将待发布内容统一发布到同一条评论线程，并按 `<nP>` 标记识别覆盖范围
- 当视频分 P 顺序发生插入、删除、重排时，自动标记“已发布线程需要重建”
- 对标题和分 P 结构一致的录播，自动复用历史总结，减少重复生成
- 支持 TV 二维码登录、刷新 Bilibili cookie、按用户最近投稿自动跑流水线、清理旧工作目录
- 自动加载仓库根目录 `.env` 中的配置

## 设计原则

### 1. Bilibili 相关能力优先走 `@renmu/bili-api`

项目里和 B 站直接相关的动作优先由 `@renmu/bili-api` 完成：

- 视频详情与分 P 信息
- 播放信息与字幕入口
- 置顶评论查询
- 发表评论 / 回复评论
- 评论置顶
- TV 登录与 refresh token 刷新

`yt-dlp` 和 `videocaptioner` 只承担媒体下载与转写兜底，不参与业务状态判断。

### 2. LLM 只负责总结，不负责任务调度

这些事情全部由代码完成：

- 判断视频身份与分 P 变化
- 判断哪些分 P 缺字幕
- 判断哪些分 P 缺总结
- 判断哪些分 P 还没发布
- 评论分块与线程维护
- 已发布线程是否需要整体重建
- 是否可以复用历史录播总结

LLM 当前只接收单个分 P 的字幕数据，返回适合发布到评论区的中文总结文本。

### 3. 总结格式以 `<nP>` 为稳定锚点

项目使用 `<1P>`、`<2P>` 这样的标记来描述分 P 覆盖范围。这样可以稳定完成：

- 总结导入
- 评论拆分
- 已发布覆盖范围识别
- 增量发布
- 分 P 重排后的重新编号

推荐格式示例：

```text
<1P>
00:00 开场先聊这次直播安排
08:45 开始讲今天要处理的问题

<2P> 这段主要是在复盘上一场直播里提到的几个结论
```

规则：

- 每个分 P 的总结都必须以 `<nP>` 开头
- 长分 P 可以在 `<nP>` 下按时间拆成多行
- 短分 P 也可以只保留单段总结
- 评论拆分时会把每个 `<nP>` 块作为最小粒度，不会把一个块拆到两条评论里

## 主流程

完整流水线由 [`scripts/run-video-pipeline.mjs`](./scripts/run-video-pipeline.mjs) 驱动：

1. 解析 `--bvid` / `--aid` / `--url`
2. 拉取视频详情与分 P 列表，并同步到 SQLite
3. 检测分 P 是否新增、删除、移动，必要时标记发布线程需要重建
4. 对缺字幕的分 P：
   - 优先复用本地已有字幕
   - 再尝试 Bilibili 原生字幕 / AI 字幕
   - 仍然没有时下载音频并转写为 `srt`
5. 对缺总结的分 P：
   - 优先尝试复用“同标题 + 同分 P 结构”的历史录播总结
   - 其余部分调用总结模型生成内容
6. 写出 `summary-pXX.md`、`summary.md`、`pending-summary.md`
7. 如果指定了 `--publish`：
   - 正常情况下只发布 `pending-summary.md`
   - 如果检测到分 P 结构变化，则删除旧线程并按 `summary.md` 全量重建

## 环境要求

- Node.js 24 或更高版本
- npm
- Python 3.11 或更高版本
- `ffmpeg` 在 `PATH` 中可用

说明：

- 项目使用 Node 内置的 `node:sqlite`
- 在 Node 24 上可用，但可能仍会打印 experimental warning

## 安装

### Windows

```powershell
npm run setup:ps
```

可选参数：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -VenvPath .3.11 -PreferredPython 3.11
```

### macOS / Linux

```bash
npm run setup:sh
```

可选环境变量：

```bash
VENV_PATH=.3.11 PREFERRED_PYTHON=python3.11 bash ./scripts/setup-env.sh
```

初始化脚本会：

- 安装 Node 依赖
- 创建 Python 虚拟环境
- 安装 `requirements.txt` 中的 `videocaptioner` 与 `yt-dlp`
- 检查 Python 工具是否可用
- 检查 `ffmpeg` 是否存在

更详细的安装说明见 [SETUP.md](./SETUP.md)。

## 配置

大部分脚本会自动加载仓库根目录的 `.env`。

### 1. Bilibili 凭据

默认文件：

- `cookie.txt`
- `bili-auth.json`

说明：

- `cookie.txt` 用于日常请求
- `bili-auth.json` 保存 TV 登录返回的 `access_token` / `refresh_token`，供后续自动刷新 cookie 使用

### 2. 总结模型配置

支持三类兼容接口：

- OpenAI `Responses API`
- OpenAI 兼容 `chat/completions`
- Anthropic 兼容 `messages`

可用环境变量：

- `SUMMARY_API_KEY` 或 `OPENAI_API_KEY`
- `SUMMARY_API_BASE_URL` 或 `OPENAI_BASE_URL`
- `SUMMARY_MODEL` 或 `OPENAI_MODEL`
- `SUMMARY_API_FORMAT` 或 `OPENAI_API_FORMAT`

也支持命令行参数：

- `--api-key`
- `--api-base-url`
- `--model`
- `--api-format`

`api-format` 可选值：

- `auto`
- `responses`
- `openai-chat`
- `anthropic-messages`

示例：

```dotenv
SUMMARY_API_KEY=your_api_key
SUMMARY_API_BASE_URL=https://api.openai.com/v1
SUMMARY_API_FORMAT=responses
SUMMARY_MODEL=gpt-4o-mini
```

如果接 OpenCode Go：

```dotenv
SUMMARY_API_KEY=your_opencode_go_key
SUMMARY_API_BASE_URL=https://opencode.ai/zen/go/v1
SUMMARY_API_FORMAT=openai-chat
SUMMARY_MODEL=glm-5
```

### 3. 调度相关配置

常用环境变量：

- `SUMMARY_USERS`：逗号分隔的 Bilibili 空间链接或 UID
- `SUMMARY_SINCE_HOURS`：扫描最近多少小时的投稿，默认 `24`
- `BILI_COOKIE_FILE`：cookie 文件路径，默认 `cookie.txt`
- `BILI_AUTH_FILE`：授权文件路径，默认 `bili-auth.json`
- `BILI_REFRESH_DAYS`：授权超过多少天后触发刷新，默认 `30`
- `WORK_CLEANUP_DAYS`：清理多少天前的工作目录，默认 `2`
- `PIPELINE_DB_PATH`：SQLite 路径，默认 `work/pipeline.sqlite3`
- `WORK_ROOT`：工作目录根路径，默认 `work`
- `CRON_TIMEZONE`：cron 时区，例如 `Asia/Shanghai`

一个常见的 `.env` 示例：

```dotenv
SUMMARY_API_KEY=your_api_key
SUMMARY_MODEL=gpt-4o-mini
SUMMARY_USERS=https://space.bilibili.com/123456,https://space.bilibili.com/234567
CRON_TIMEZONE=Asia/Shanghai
```

## 常用命令

### 1. 跑完整流水线

只生成字幕和总结，不发布：

```bash
npm run pipeline -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx
```

生成后直接发布：

```bash
npm run pipeline -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --publish
```

强制重新生成所有分 P 总结：

```bash
npm run pipeline -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --force-summary
```

### 2. 只同步视频与分 P 状态

```bash
npm run sync:video -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx
```

### 3. 手工导入总结

```bash
npm run import:summary -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --summary-file work/BVxxxxxxxxxx/summary.md
```

### 4. 只发布未发布总结

```bash
npm run publish:pending -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx
```

如果想强制回复到某条根评论：

```bash
npm run publish:pending -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --root-rpid 1234567890
```

### 5. 查询当前置顶评论

```bash
node scripts/get-bili-top-comment.mjs --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx
```

### 6. 手工发送一份总结

```bash
node scripts/post-bili-summary.mjs --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --message-file work/BVxxxxxxxxxx/pending-summary.md
```

### 7. 初始化 TV 登录

```bash
npm run login:bili
```

运行后脚本会输出二维码 URL。扫码成功后会写入：

- `bili-auth.json`
- `cookie.txt`

### 8. 刷新 cookie

```bash
npm run refresh:cookie
```

也支持直接传 token：

```bash
node scripts/refresh-bili-cookie.mjs --access-token <token> --refresh-token <token>
```

### 9. 扫描指定用户最近投稿并跑流水线

```bash
npm run sync:users -- --cookie-file ./cookie.txt --summary-users "https://space.bilibili.com/1,https://space.bilibili.com/2"
```

### 10. 清理旧工作目录

```bash
npm run cleanup:work -- --cleanup-days 2
```

### 11. 启动定时调度

```bash
npm run schedule -- --run-on-start
```

只执行一次并退出：

```bash
node scripts/run-scheduler.mjs --once summary
node scripts/run-scheduler.mjs --once refresh
node scripts/run-scheduler.mjs --once cleanup
node scripts/run-scheduler.mjs --once all
```

调度细节见 [SCHEDULE.md](./SCHEDULE.md)。

## 输出文件

默认工作目录：

```text
work/<BV号>/
```

常见产物：

- `cid-<cid>.srt`：该分 P 的字幕
- `cid-<cid>.m4a`：转写兜底时下载的音频
- `summary-p01.md`、`summary-p02.md`：分 P 总结
- `summary.md`：所有分 P 的完整汇总
- `pending-summary.md`：当前尚未发布的汇总

说明：

- 字幕和音频文件现在按 `cid` 命名，避免分 P 号变化时路径失效
- `summary-pXX.md` 仍按页码输出，便于人工查看
- 如果分 P 被删除，对应的旧 `summary-pXX.md` 会在重写汇总时清理掉

## SQLite 状态

默认数据库路径：

```text
work/pipeline.sqlite3
```

### `videos`

记录视频级状态：

- `bvid`
- `aid`
- `title`
- `page_count`
- `root_comment_rpid`
- `top_comment_rpid`
- `publish_needs_rebuild`
- `publish_rebuild_reason`
- `last_scan_at`

### `video_parts`

记录分 P 级状态：

- `page_no`
- `cid`
- `part_title`
- `duration_sec`
- `subtitle_path`
- `subtitle_source`
- `subtitle_lang`
- `summary_text`
- `summary_hash`
- `published`
- `published_comment_rpid`
- `published_at`
- `is_deleted`
- `deleted_at`

这些状态主要用来回答几个问题：

- 哪些分 P 还没有字幕
- 哪些分 P 还没有总结
- 哪些分 P 还没有发布
- 已发布线程是否因为分 P 结构变化而需要重建
- 当前视频是否能复用旧录播总结

## 评论发布策略

发布策略是“单根评论线程”：

- 第一次发布时创建根评论并尝试置顶
- 后续增量内容全部回复到同一条根评论下
- 超过 1000 字时自动拆成多条评论
- 已存在根评论失效或被删时，脚本会自动创建新线程

拆分规则：

- 以 `<nP>` 总结块为最小粒度
- 不会把同一个 `<nP>` 块拆到两条评论里

重建规则：

- 如果只是尾部新增分 P，继续增量发布
- 如果发生中间插入、删除、重排，标记 `publish_needs_rebuild = 1`
- 下次执行发布时会删除旧线程、重置已发布状态，并按 `summary.md` 全量重发

## 字幕获取策略

优先级如下：

1. 本地已有字幕文件
2. Bilibili 原生字幕 / AI 字幕
3. `yt-dlp` 下载音频
4. `videocaptioner transcribe` 转写为 `srt`

当前默认转写参数：

- ASR 引擎：`bijian`
- 语言：`auto`
- 输出格式：`srt`

## 录播总结复用策略

当以下条件同时满足时，流水线会复用历史总结而不是重新调用模型：

- 视频标题在规范化后相同
- 分 P 数量一致
- 各分 P 标题顺序一致
- 历史视频的每个分 P 都已经有 `summary_text` 和 `summary_hash`

标题规范化会去掉一些常见后缀，例如：

- `纯净版`
- `弹幕版`
- `无弹幕版`
- `录播版`
- `熟肉版`

## 关键脚本

- `scripts/run-video-pipeline.mjs`：总入口，负责同步、字幕、总结、发布
- `scripts/sync-bili-video-state.mjs`：只做视频与分 P 状态同步
- `scripts/import-summary-file.mjs`：将已有总结文件导入 SQLite
- `scripts/publish-pending-summaries.mjs`：发布未发布总结，必要时重建线程
- `scripts/post-bili-summary.mjs`：底层评论发布脚本
- `scripts/login-bili-tv.mjs`：通过 TV 二维码登录获取可刷新的授权
- `scripts/refresh-bili-cookie.mjs`：用 refresh token 刷新 cookie
- `scripts/sync-summary-users.mjs`：扫描指定用户最近投稿并逐个执行流水线
- `scripts/run-scheduler.mjs`：常驻调度入口
- `scripts/cleanup-work-files.mjs`：清理过期工作目录

## 已知限制

- 总结能力仍依赖一个兼容 OpenAI / Anthropic 风格的在线接口
- `node:sqlite` 在当前 Node 版本下可能打印 experimental warning
- Bilibili 字幕接口是否可用，受视频权限、字幕存在情况和账号状态影响
- 当前没有完整测试套件，主要依赖脚本化验证和实际运行检查

## 相关文档

- [SETUP.md](./SETUP.md)：环境准备与安装说明
- [SCHEDULE.md](./SCHEDULE.md)：定时任务与部署方式
