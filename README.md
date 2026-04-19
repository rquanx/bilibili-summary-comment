# video-pipeline

一个面向 Bilibili 视频总结与评论发布场景的命令行流水线。

项目目标是把“视频链接 / BV 号 -> 分 P 状态同步 -> 字幕获取 -> 分 P 总结 -> 评论区发布 -> 定时巡检”这条链路尽量固化到代码里，让 LLM 只负责总结正文生成，而不是负责流程编排。

## 当前能力

- 读取 `BV`、`aid` 或视频 URL，并同步视频与分 P 元数据到本地 SQLite
- 优先复用本地字幕，再尝试 Bilibili 原生字幕 / AI 字幕，最后再走 `yt-dlp + videocaptioner`
- 默认使用 `faster-whisper` 转写，失败后会按顺序回退到 `bijian`、`jianying`
- 为每个分 P 生成独立总结，并产出 `summary-pXX.md`、`summary.md`、`pending-summary.md`
- 支持导入人工整理的总结文件，`1P` 和 `<1P>` 标记都会被规范化为 `<1P>`
- 将待发布内容统一发布到同一条评论线程，并按 `<nP>` 标记识别覆盖范围
- 当视频分 P 顺序发生插入、删除、重排时，自动标记“已发布线程需要重建”
- 对同标题且分 P 结构一致的录播自动复用历史总结，减少重复生成
- 扫描指定 UP 最近投稿时，会把同一场录播的不同标题变体串行排队，优先跑更早的版本，便于复用总结和评论线程
- 支持 TV 终端二维码登录、refresh token 刷新授权、缺段巡检、定时巡检、工作目录清理、事件巡检和 `dist` 打包
- 自动加载仓库根目录 `.env`

## 设计原则

### 1. Bilibili 相关能力优先走 `@renmu/bili-api`

项目里和 B 站直接相关的动作优先由 `@renmu/bili-api` 完成：

- 视频详情与分 P 信息
- 播放信息与字幕入口
- 置顶评论查询
- 发表评论 / 回复评论 / 删除旧线程
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
- 评论拆分时会把每个 `<nP>` 块作为最小粒度
- 单条评论上限按 B 站当前实现控制在 `700` 字以内，超长块会在块内优先按空行、换行、中文标点拆开

## 环境要求

- Node.js `24` 或更高版本
- npm
- Python `3.11` 或更高版本
- `ffmpeg` 在 `PATH` 中可用

说明：

- 项目使用 Node 内置的 `node:sqlite`
- 在 Node 24 上可用，但可能仍会打印 experimental warning

## 安装

Windows：

```powershell
npm run setup:ps
```

macOS / Linux：

```bash
npm run setup:sh
```

初始化脚本会：

- 安装 Node 依赖
- 创建 Python 虚拟环境
- 安装 `requirements.txt` 中的 `videocaptioner` 与 `yt-dlp`
- 检查 Python 工具是否可用
- 检查 `ffmpeg` 是否存在

更详细的安装与首跑说明见 [SETUP.md](./SETUP.md)。

## 快速开始

1. 安装依赖并准备虚拟环境

   ```powershell
   npm run setup:ps
   ```

2. 在仓库根目录创建 `.env`

   ```dotenv
   SUMMARY_API_KEY=your_api_key
   SUMMARY_MODEL=gpt-4o-mini
   SUMMARY_USERS=https://space.bilibili.com/123456
   CRON_TIMEZONE=Asia/Shanghai
   ```

3. 初始化 Bilibili TV 登录

   ```bash
   npm run login:bili
   ```

4. 跑一条视频的完整流水线

   ```bash
   npm run pipeline -- --auth-file ./.auth/bili-auth.json --bvid BVxxxxxxxxxx --publish
   ```

## 配置

大部分脚本会自动加载仓库根目录的 `.env`，CLI 参数优先级高于环境变量。

### 1. Bilibili 凭据

默认文件：

- `.auth/bili-auth.json`

说明：

- `.auth/bili-auth.json` 保存 TV 登录返回的 `access_token` / `refresh_token` 与 cookie 信息，是默认的凭据来源
- 如果 `.auth/bili-auth.json` 已存在，再次执行 `npm run login:bili` 会自动写入 `.auth/bili-auth_2.json`，后续依次递增
- 多用户调度时，`SUMMARY_USERS` 会按顺序优先匹配 `.auth/bili-auth_1.json`、`.auth/bili-auth_2.json`……，找不到再回退到基础文件 `.auth/bili-auth.json`
- `cookie.txt` / `BILI_COOKIE_FILE` 现在只作为兼容参数保留；默认流程不会再回退到 cookie 文件，只有你显式传了 `--cookie-file` 时才会直接使用 cookie
- 如果改了路径，优先使用 `BILI_AUTH_FILE` 或对应命令行参数覆盖；`BILI_COOKIE_FILE` 仅在你明确需要传入或额外输出 cookie 文件时使用

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

OpenAI 兼容示例：

```dotenv
SUMMARY_API_KEY=your_api_key
SUMMARY_API_BASE_URL=https://api.openai.com/v1
SUMMARY_API_FORMAT=responses
SUMMARY_MODEL=gpt-4o-mini
```

OpenCode Go 示例：

```dotenv
SUMMARY_API_KEY=your_opencode_go_key
SUMMARY_API_BASE_URL=https://opencode.ai/zen/go/v1
SUMMARY_API_FORMAT=openai-chat
SUMMARY_MODEL=glm-5
```

### 3. 调度与运行时配置

常用环境变量：

- `SUMMARY_USERS`：逗号或换行分隔的 Bilibili 空间链接或 UID
- `SUMMARY_SINCE_HOURS`：扫描最近多少小时的投稿，默认 `24`
- `SUMMARY_PIPELINE_CONCURRENCY`：同时最多跑多少条视频流水线，默认 `3`
- `BILI_AUTH_FILE`：授权文件路径，默认 `.auth/bili-auth.json`
- `BILI_COOKIE_FILE`：可选。cookie 文件路径；仅在你显式使用 `--cookie-file` 或要求额外输出 cookie 文件时使用
- `BILI_REFRESH_DAYS`：授权超过多少天后触发刷新，默认 `30`
- `WORK_CLEANUP_DAYS`：清理多少天前的工作目录，默认 `2`
- `PIPELINE_DB_PATH`：SQLite 路径，默认 `work/pipeline.sqlite3`
- `WORK_ROOT`：工作目录根路径，默认 `work`
- `CRON_TIMEZONE`：cron 时区，例如 `Asia/Shanghai`
- `SERVER_CHAN_SEND_KEY`：可选，转写连续失败或缺段巡检发现新缺口时通过 ServerChan 发送通知

## 常用命令

### 1. 跑完整流水线

只生成字幕和总结，不发布：

```bash
npm run pipeline -- --auth-file ./.auth/bili-auth.json --bvid BVxxxxxxxxxx
```

生成后直接发布：

```bash
npm run pipeline -- --auth-file ./.auth/bili-auth.json --bvid BVxxxxxxxxxx --publish
```

强制重新生成所有分 P 总结：

```bash
npm run pipeline -- --auth-file ./.auth/bili-auth.json --bvid BVxxxxxxxxxx --force-summary
```

改用其他 ASR：

```bash
npm run pipeline -- --auth-file ./.auth/bili-auth.json --bvid BVxxxxxxxxxx --asr bijian
```

### 2. 只同步视频与分 P 状态

```bash
npm run sync:video -- --auth-file ./.auth/bili-auth.json --bvid BVxxxxxxxxxx
```

### 3. 手工导入总结

```bash
npm run import:summary -- --auth-file ./.auth/bili-auth.json --bvid BVxxxxxxxxxx --summary-file work/BVxxxxxxxxxx/summary.md
```

### 4. 只发布未发布总结

```bash
npm run publish:pending -- --auth-file ./.auth/bili-auth.json --bvid BVxxxxxxxxxx
```

如果想强制回复到某条根评论：

```bash
npm run publish:pending -- --auth-file ./.auth/bili-auth.json --bvid BVxxxxxxxxxx --root-rpid 1234567890
```

### 5. 查询当前置顶评论

```bash
tsx scripts/commands/get-bili-top-comment.ts --auth-file ./.auth/bili-auth.json --bvid BVxxxxxxxxxx
```

### 6. 手工发送一份总结

```bash
tsx scripts/commands/post-bili-summary.ts --auth-file ./.auth/bili-auth.json --bvid BVxxxxxxxxxx --message-file work/BVxxxxxxxxxx/pending-summary.md
```

### 7. 初始化 TV 登录

```bash
npm run login:bili
```

运行后脚本会在 terminal 中直接输出可扫码二维码，并同时打印登录 URL 作为兜底。

默认会写入：

- `.auth/bili-auth.json`

如果该文件已存在，会自动递增为 `.auth/bili-auth_2.json`、`.auth/bili-auth_3.json`……

如果你仍然需要额外产出 cookie 文件，可以显式传：

```bash
tsx scripts/commands/login-bili-tv.ts --auth-file ./secrets/bili-auth.json --cookie-file ./secrets/cookie.txt
```

### 8. 刷新授权

```bash
npm run refresh:cookie
```

默认会刷新授权文件中的 token 与 cookie 信息；如果你显式传了 `--cookie-file`，也会同步写出 cookie 文本文件。

也支持直接传 token：

```bash
tsx scripts/commands/refresh-bili-cookie.ts --access-token <token> --refresh-token <token>
```

### 9. 扫描指定用户最近投稿并跑流水线

```bash
npm run sync:users -- --auth-file ./.auth/bili-auth.json --summary-users "https://space.bilibili.com/1,https://space.bilibili.com/2"
```

说明：

- 该命令当前默认会为命中的视频执行完整流水线并自动发布
- 多账号时建议按用户顺序准备 `.auth/bili-auth_1.json`、`.auth/bili-auth_2.json`……；第 1 个用户也可以直接使用基础文件 `.auth/bili-auth.json`
- 同一 UP、同一场录播的不同标题变体会串行运行，避免并发抢占同一份总结 / 评论线程

### 10. 清理旧工作目录

```bash
npm run cleanup:work -- --cleanup-days 2
```

### 11. 启动定时调度

```bash
npm run schedule
```

启动后先立刻跑一轮再常驻：

```bash
npm run start
# 等价于 npm run schedule -- --run-on-start
```

只执行一次并退出：

```bash
tsx scripts/commands/run-scheduler.ts --once summary
tsx scripts/commands/run-scheduler.ts --once gap-check
tsx scripts/commands/run-scheduler.ts --once refresh
tsx scripts/commands/run-scheduler.ts --once cleanup
tsx scripts/commands/run-scheduler.ts --once all
```

说明：

- 调度器当前会注册 4 个任务：整点跑总结、每小时 `10` 分跑缺段巡检、每天 `03:15` 检查授权刷新、每天 `03:45` 清理工作目录
- 缺段巡检会把当天快照写到 `work/logs/gap-check/YYYY-MM-DD.json`

调度细节见 [SCHEDULE.md](./SCHEDULE.md)。

### 12. 维护与验证

构建 `dist`：

```bash
npm run build
```

运行测试：

```bash
npm test
npm run typecheck
```

检查最近流水线事件：

```bash
npm run inspect:events -- --since-hours 24 --limit 100
```

## 主流程

完整流水线由 [`scripts/commands/run-video-pipeline.ts`](./scripts/commands/run-video-pipeline.ts) 驱动：

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

- 字幕和音频文件按 `cid` 命名，避免分 P 号变化时路径失效
- `summary-pXX.md` 仍按页码输出，便于人工查看
- 如果分 P 被删除，对应的旧 `summary-pXX.md` 会在重写汇总时自动清理

## SQLite 状态

默认数据库路径：

```text
work/pipeline.sqlite3
```

核心表：

- `videos`：视频级状态、评论线程状态、是否需要重建发布线程
- `video_parts`：分 P 状态、字幕路径、总结文本、发布状态、删除标记
- `pipeline_events`：每次流水线运行的事件日志，供排错和巡检使用

常见问题都由这些状态回答：

- 哪些分 P 还没有字幕
- 哪些分 P 还没有总结
- 哪些分 P 还没有发布
- 已发布线程是否因为分 P 结构变化而需要重建
- 当前视频是否能复用旧录播总结

## 评论发布策略

发布策略是“单根评论线程”：

- 第一次发布时创建根评论并尝试置顶
- 后续增量内容全部回复到同一条根评论下
- 已存在根评论失效或被删时，脚本会自动创建新线程
- 发布后会检查线程是否真正出现在视频评论页里

拆分规则：

- 以 `<nP>` 总结块为最小粒度
- 单条评论默认不超过 `700` 字
- 如果单个 `<nP>` 块过长，会在块内优先按空行、换行和中文标点切分

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

- 默认 ASR：`faster-whisper`
- 默认回退链：`faster-whisper -> bijian -> jianying`
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
- `无弹幕版`
- `弹幕版`
- `录播版`
- `熟肉版`

批量扫描最近投稿时，同一场录播的不同变体还会按“更早上传优先”的顺序串行执行，方便后面的版本直接复用前面的总结和评论线程。

## 已知限制

- 总结能力仍依赖一个兼容 OpenAI / Anthropic 风格的在线接口
- `node:sqlite` 在当前 Node 版本下可能打印 experimental warning
- Bilibili 字幕接口是否可用，受视频权限、字幕存在情况和账号状态影响
- 评论发布链路依赖 B 站页面可见性校验，偶发平台侧延迟时可能需要重试

## 相关文档

- [SETUP.md](./SETUP.md)：环境准备、首跑与验证
- [SCHEDULE.md](./SCHEDULE.md)：定时任务与部署方式

## 按用户定制 Summary Prompt

项目现在支持通过独立配置文件按用户定制 summary prompt，默认读取 `config/summary-prompts.json`，并按 `defaults -> preset -> user` 的顺序合并附加规则。

可通过环境变量或命令行覆盖路径：

```dotenv
SUMMARY_PROMPT_CONFIG=config/summary-prompts.json
```

```bash
npm run pipeline -- --bvid BVxxxxxxxxxx --prompt-config ./config/summary-prompts.json
```

配置示例：

```json
{
  "defaults": {
    "extraRules": []
  },
  "presets": {
    "live-entertainment": {
      "displayName": "娱乐主播",
      "extraRules": []
    },
    "live-knowledge": {
      "displayName": "知识主播",
      "extraRules": [
        "如果当前分P是知识、观点、分析密集型内容，不要只压缩成过短的提纲式概述；在保持可读性的前提下，适度展开核心知识点、结论、论证依据和限制条件。"
      ]
    }
  },
  "users": {
    "3690987547265027": {
      "preset": "live-entertainment"
    },
    "3690976520440286": {
      "preset": "live-knowledge"
    }
  }
}
```

说明：

- `defaults.extraRules` 会追加到所有用户的基础 prompt 后面
- `presets` 用来管理一类主播的共用风格
- `users.<mid>.preset` 负责把具体用户绑定到某个 preset
- `users.<mid>.extraRules` 可继续追加更细的用户规则
- 附加规则不会替换基础格式约束，仍然保留现有 `<nP>` 和时间点输出规则
