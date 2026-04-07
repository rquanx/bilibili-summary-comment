# video-pipeline

一个面向 Bilibili 直播录像总结场景的命令行流水线。

目标是把“视频链接 / BV 号 -> 分 P 信息 -> 字幕获取 -> 分 P 总结 -> 评论发布”这条链路尽量收回到代码里，只把真正需要语言生成的部分交给 LLM，减少无谓的 prompt 调度和 token 消耗。

## 项目目标

- 用代码完成流程编排，而不是让 LLM 决定下一步做什么
- 尽量使用 `@renmu/bili-api` 处理 Bilibili 相关接口
- 用本地 SQLite 记录视频、分 P、字幕、总结和发布状态
- 评论统一发布到同一条根评论线程里
- 总结正文支持 `<1P>`、`<2P>` 这样的标记，方便做覆盖识别和增量发布
- 字幕尽量原样保留，不做清洗

## 当前能力

- 读取 `BV 号 / aid / 视频 URL`
- 使用 `@renmu/bili-api` 拉取视频元信息、分 P 信息、置顶评论信息
- 将视频和分 P 状态同步到本地 SQLite
- 优先尝试获取 B 站原生字幕或 AI 字幕
- 如果拿不到字幕，则用 `yt-dlp + videocaptioner` 下载音频并转写 SRT
- 按分 P 生成总结并写回 SQLite
- 生成总汇总 `summary.md` 和待发布汇总 `pending-summary.md`
- 把待发布内容发布到同一条评论线程中
- 自动识别哪些分 P 已发布，避免重复评论

## 设计原则

### 1. Bilibili 接口优先走 `@renmu/bili-api`

项目里和 B 站直接相关的能力，优先使用 `@renmu/bili-api`：

- 视频详情
- 分 P 信息
- 播放信息与字幕入口
- 置顶评论查询
- 发表评论
- 楼中楼回复
- 评论置顶

`yt-dlp` 的定位是媒体和字幕兜底工具，不承担业务状态判断。

### 2. 字幕不清洗

项目当前策略是“识别出来是什么就是什么”：

- 不做语气词清理
- 不做重复句去重
- 不做 ASR 降噪
- 不做自动润色

代码只做最小必要的格式解析：

- SRT 读取
- 时间戳解析
- 为长分 P 提供时间段切分提示

### 3. LLM 只做总结，不做调度

LLM 目前只负责把字幕整理成适合评论区发布的自然语言总结。

这些步骤都由代码完成：

- 判断视频身份
- 同步分 P
- 判断哪些分 P 缺字幕
- 判断哪些分 P 缺总结
- 判断哪些分 P 未发布
- 评论切块
- 评论线程维护

## 工作流

完整流程如下：

1. 解析 `BV / aid / URL`
2. 拉取视频详情与分 P 信息
3. 将视频和分 P 写入 SQLite
4. 对缺字幕的分 P：
   - 先尝试 B 站原生字幕
   - 再尝试 B 站 AI 字幕
   - 都没有时，下载音频并转写
5. 对缺总结的分 P：
   - 读取该分 P 原始字幕
   - 调用 LLM 生成 `<nP>` 样式总结
   - 写回 SQLite
6. 汇总所有总结到 `summary.md`
7. 汇总未发布总结到 `pending-summary.md`
8. 如果指定 `--publish`：
   - 复用同一条根评论线程
   - 按 1000 字限制自动拆分
   - 发布后把对应分 P 标记为已发布

## 评论格式

项目现在推荐的分 P 标记格式是：

```text
<1P> 00:00 - 05:00 开场闲聊
- 内容点 1
- 内容点 2

<1P> 05:00 - 11:20 去看人前的铺垫
- 内容点 1

<2P> 直接一把速连，聊两句就撤
```

说明：

- 每个分 P 总结块都以 `<nP>` 开头
- 同一个分 P 可以有多个块
- 长分 P 可以带时间范围
- 短分 P 可以只有一段总结
- 评论拆分时，以这些块作为最小粒度

这样做的好处是：

- 代码能稳定识别“这条评论覆盖了哪些分 P”
- 后续增量发布时不容易误判
- 人工修订总结时也更容易保持结构一致

## 目录结构

```text
.
├─ scripts/
│  ├─ run-video-pipeline.mjs
│  ├─ sync-bili-video-state.mjs
│  ├─ import-summary-file.mjs
│  ├─ publish-pending-summaries.mjs
│  ├─ post-bili-summary.mjs
│  ├─ get-bili-top-comment.mjs
│  └─ lib/
│     ├─ bili-comment-utils.mjs
│     ├─ comment-thread.mjs
│     ├─ runtime-tools.mjs
│     ├─ srt-utils.mjs
│     ├─ storage.mjs
│     ├─ subtitle-pipeline.mjs
│     ├─ summarizer.mjs
│     ├─ summary-files.mjs
│     ├─ summary-format.mjs
│     └─ video-state.mjs
├─ work/
├─ requirements.txt
├─ SETUP.md
├─ prompt.md
└─ cookie.txt
```

## 环境要求

- Node.js 24 或更高
- npm
- Python 3.11 或更高
- `ffmpeg` 在 `PATH` 中可用

说明：

- 项目使用 Node 内置 `node:sqlite`
- 在 Node 24 上它可用，但可能会打印 experimental warning

## 安装与初始化

### Windows

```powershell
npm run setup:ps
```

### macOS / Linux

```bash
bash ./scripts/setup-env.sh
```

初始化脚本会做这些事：

- 安装 Node 依赖
- 创建 Python 虚拟环境
- 安装 `videocaptioner`
- 安装 `yt-dlp`
- 检查 `ffmpeg`

更详细的环境准备说明见 [SETUP.md](/d:/data/transcript/summary/SETUP.md)。

## 配置

### 1. Bilibili Cookie

默认使用仓库根目录的 `cookie.txt`：

```text
./cookie.txt
```

命令里也可以显式传：

```bash
--cookie-file ./cookie.txt
```

### 2. 总结模型配置

项目通过兼容接口生成总结，支持以下几种请求格式：
- OpenAI `Responses API`（`/v1/responses`）
- OpenAI 兼容 `chat/completions`
- Anthropic 兼容 `messages`

可用环境变量：

- `SUMMARY_API_KEY` 或 `OPENAI_API_KEY`
- `SUMMARY_API_BASE_URL` 或 `OPENAI_BASE_URL`
- `SUMMARY_MODEL` 或 `OPENAI_MODEL`
- `SUMMARY_API_FORMAT` 或 `OPENAI_API_FORMAT`

也可以命令行传参：

- `--api-key`
- `--api-base-url`
- `--model`
- `--api-format`

`api-format` 可选值：
- `auto`
- `responses`
- `openai-chat`
- `anthropic-messages`

如果你想接 `OpenCode Go`，推荐这样配：

```dotenv
SUMMARY_API_KEY=your_opencode_go_key
SUMMARY_API_BASE_URL=https://opencode.ai/zen/go/v1
SUMMARY_API_FORMAT=openai-chat
SUMMARY_MODEL=glm-5
```

### 3. Python venv 路径

默认虚拟环境路径是：

```text
.3.11
```

如果你在别处部署，也可以通过参数改：

```bash
--venv-path /path/to/venv
```

## 常用命令

### 1. 跑完整流水线

只生成字幕和总结，不发评论：

```bash
npm run pipeline -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx
```

生成后直接发布到评论区：

```bash
npm run pipeline -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --publish
```

强制重新生成所有分 P 总结：

```bash
npm run pipeline -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --force-summary
```

### 2. 只同步视频和分 P 状态

```bash
npm run sync:video -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx
```

### 3. 手工导入总结到 SQLite

当你已经有一份人工写好的 `summary.md`，并且里面使用了 `<1P>` 这种标记格式时：

```bash
npm run import:summary -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --summary-file work/BVxxxxxxxxxx/summary.md
```

### 4. 只发布还没发出去的总结

```bash
npm run publish:pending -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx
```

### 5. 单独查置顶评论

```bash
node scripts/get-bili-top-comment.mjs --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx
```

### 6. 手工发一份总结

```bash
node scripts/post-bili-summary.mjs --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --message-file work/BVxxxxxxxxxx/pending-summary.md
```

## 输出文件

针对某个视频，默认输出目录是：

```text
work/<BV号>/
```

常见产物包括：

- `p01.srt`、`p02.srt`
- `p01.m4a`、`p02.m4a`
- `summary-p01.md`
- `summary-p02.md`
- `summary.md`
- `pending-summary.md`

说明：

- 如果 B 站有字幕，会直接保存为对应的 `pXX.srt`
- 如果没有字幕，会先下载音频再转写出 `pXX.srt`
- `summary.md` 是所有分 P 的完整汇总
- `pending-summary.md` 只包含还未发布到评论区的部分

## SQLite 状态

默认数据库路径：

```text
work/pipeline.sqlite3
```

当前主要有两张表。

### `videos`

记录视频级状态：

- `bvid`
- `aid`
- `title`
- `page_count`
- `root_comment_rpid`
- `top_comment_rpid`
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

这套状态主要用来解决三个问题：

- 哪些分 P 还没拿到字幕
- 哪些分 P 还没生成总结
- 哪些分 P 还没发布到评论区

## 评论发布策略

评论策略是“单根评论线程”：

- 第一次发布时，新建一条根评论
- 必要时把这条根评论置顶
- 后续增量内容全部回复到这条根评论下面
- 超过 1000 字时自动拆成多条楼中楼

拆分规则：

- 以 `<nP>` 总结块为最小粒度
- 不会把一个块拆到两条评论里

覆盖识别规则：

- 通过 `<1P>`、`<2P>` 这种标记反向识别评论覆盖的分 P
- 发布成功后，对应分 P 会被标记为 `published = 1`

## 字幕获取策略

优先级如下：

1. 本地已有字幕文件
2. B 站原生字幕 / AI 字幕
3. `yt-dlp` 下载音频
4. `videocaptioner transcribe` 生成字幕

当前默认转写参数偏向低门槛部署：

- ASR 引擎默认 `bijian`
- 输出格式 `srt`
- 语言参数 `auto`

## 总结生成策略

总结器会读取原始字幕，并根据时长提供一个“是否分段”的提示，但不会清洗字幕正文。

它的职责是：

- 生成适合评论区发布的口语化表达
- 保持 `<nP>` 标记
- 长分 P 可分多个时间段块
- 短分 P 则保留单段输出

当前实现已经兼容 `responses`、`chat/completions` 和 `messages` 三种风格；如果你后续还想替换为本地模型或别的 provider，主要改动点仍然是 `scripts/lib/summarizer.mjs`。

## 建议使用方式

### 场景 1：全自动跑一遍

```bash
npm run pipeline -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --publish
```

适合：

- 新视频首次总结
- 已配置好总结模型接口
- 希望自动发布

### 场景 2：先生成，人工看一遍，再发

```bash
npm run pipeline -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx
```

然后查看：

```text
work/<BV号>/summary.md
work/<BV号>/pending-summary.md
```

确认没问题后再发：

```bash
npm run publish:pending -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx
```

### 场景 3：人工改写总结后导入并发布

```bash
npm run import:summary -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx --summary-file work/BVxxxxxxxxxx/summary.md
npm run publish:pending -- --cookie-file ./cookie.txt --bvid BVxxxxxxxxxx
```

## 关键脚本说明

### `scripts/run-video-pipeline.mjs`

总入口，负责串起：

- 状态同步
- 字幕获取
- 总结生成
- 可选发布

### `scripts/sync-bili-video-state.mjs`

只做 B 站元信息同步，不做字幕和总结。

### `scripts/import-summary-file.mjs`

将已有总结文件写入 SQLite。

### `scripts/publish-pending-summaries.mjs`

将数据库中 `published = 0` 的总结统一发布。

### `scripts/post-bili-summary.mjs`

底层评论发布脚本，可直接传入文本或文本文件。

## 开发说明

### 模块划分

- `bili-comment-utils.mjs`
  处理参数、cookie、Bilibili client、评论查询等基础能力
- `video-state.mjs`
  负责视频 / 分 P 状态同步
- `storage.mjs`
  负责 SQLite 结构与 CRUD
- `subtitle-pipeline.mjs`
  负责字幕获取和转写兜底
- `summarizer.mjs`
  负责调用总结模型
- `comment-thread.mjs`
  负责评论线程维护和发布
- `summary-format.mjs`
  负责 `<nP>` 标记规范化、切块和覆盖识别
- `summary-files.mjs`
  负责汇总文件落盘

### 为什么不用 LLM 做增量判断

因为这些判断本质上是结构化状态问题，不是语言理解问题：

- 分 P 是否存在
- 总结是否已生成
- 评论是否已发布
- 哪些内容需要追加

这些都由 SQLite 和固定规则处理更稳定，也更省 token。

## 已知限制

- 目前总结仍然依赖一个兼容 OpenAI / Anthropic 风格的在线接口
- `node:sqlite` 在当前 Node 版本上可能带 experimental warning
- B 站字幕接口是否可用，受视频权限和账号状态影响
- 目前没有完整测试套件，主要靠脚本帮助和烟雾测试验证

## 后续可继续优化的方向

- 增加真正的端到端测试
- 增加失败重试和任务恢复机制
- 为总结器加入更精细的 prompt 压缩策略
- 为每个分 P 记录字幕哈希，进一步减少重复总结
- 把评论线程里每条回复的 `rpid` 与具体分 P 建立更细粒度映射
- 提供一个统一的 `status` 命令查看数据库状态

## 相关文件

- 需求和原始工作流说明见 [prompt.md](/d:/data/transcript/summary/prompt.md)
- 环境准备说明见 [SETUP.md](/d:/data/transcript/summary/SETUP.md)
