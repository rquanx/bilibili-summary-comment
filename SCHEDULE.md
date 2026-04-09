# 定时任务说明

这个项目现在提供了一个基于 `node-cron` 的常驻调度入口，以及 4 个可单独执行的脚本：

- `npm run login:bili`
- `npm run refresh:cookie`
- `npm run sync:users`
- `npm run cleanup:work`
- `npm run schedule`

## 1. 先准备可刷新的 B 站授权

如果你希望“每 30 天自动刷新 cookie”，不能只依赖现在的 `cookie.txt`。

自动刷新依赖 `@renmu/bili-api` 的 TV 登录刷新参数，也就是：

- `access_token`
- `refresh_token`

项目默认会把这份授权信息保存到：

```text
work/bili-auth.json
```

最简单的初始化方式：

```bash
npm run login:bili
```

运行后脚本会输出一个二维码 URL。扫码登录成功后会自动写入：

- `work/bili-auth.json`
- `cookie.txt`

后续定时刷新和总结流程都会继续复用这两个文件。

## 2. 环境变量

建议在 `.env` 里至少配置这些变量：

```dotenv
SUMMARY_USERS=https://space.bilibili.com/123456,https://space.bilibili.com/234567
CRON_TIMEZONE=Asia/Shanghai
```

支持的调度相关变量：

- `SUMMARY_USERS`
  逗号分隔的 Bilibili 用户空间链接，或直接填 UID。
- `SUMMARY_SINCE_HOURS`
  扫描最近多少小时的投稿，默认 `24`。
- `BILI_AUTH_FILE`
  TV 登录授权文件路径，默认 `work/bili-auth.json`。
- `BILI_COOKIE_FILE`
  cookie 文件路径，默认 `cookie.txt`。
- `BILI_REFRESH_DAYS`
  授权超过多少天后触发刷新，默认 `30`。
- `WORK_CLEANUP_DAYS`
  清理多少天前的 `work/<BV号>` 目录，默认 `2`。
- `PIPELINE_DB_PATH`
  SQLite 路径，默认 `work/pipeline.sqlite3`。
- `WORK_ROOT`
  工作目录根路径，默认 `work`。
- `CRON_TIMEZONE`
  cron 时区，例如 `Asia/Shanghai`。

## 3. 调度行为

`npm run schedule` 启动后，会注册这 3 个定时任务：

- 每小时整点：
  扫描 `SUMMARY_USERS` 最近 24 小时投稿，并对命中的视频执行现有总结流水线，默认携带 `--publish` 自动发布/更新摘要评论。
- 每天 `03:15`：
  检查 `work/bili-auth.json` 是否超过 30 天未更新；如果超过，就刷新 cookie。
- 每天 `03:45`：
  清理数据库中最后扫描时间早于 2 天前的 `work/<BV号>` 目录。

说明：

- “每 30 天刷新一次”是通过“每日检查 + 超过 30 天才执行”实现的，这样比单纯写一个月度 cron 更接近真实的 30 天周期。
- 清理时不会删除数据库记录，只会删除 `work` 目录中的文件。
- 按用户扫描时会复用现有 `run-video-pipeline.ts`，所以已经做过总结的分 P 会自动跳过。
- 按用户扫描触发的流水线默认会追加 `--publish`，因此有待发布内容时会直接发到投稿评论区并尝试置顶根评论。

## 4. 常用命令

手动初始化 TV 登录：

```bash
npm run login:bili
```

手动刷新 cookie：

```bash
npm run refresh:cookie
```

手动扫一轮最近投稿：

```bash
npm run sync:users
```

手动清理旧文件：

```bash
npm run cleanup:work
```

只执行一次调度任务，不常驻：

```bash
tsx scripts/commands/run-scheduler.ts --once summary
tsx scripts/commands/run-scheduler.ts --once refresh
tsx scripts/commands/run-scheduler.ts --once cleanup
tsx scripts/commands/run-scheduler.ts --once all
```

启动后先立刻跑一轮，再进入常驻：

```bash
npm run schedule -- --run-on-start
```

## 5. 建议部署方式

Windows 下建议把下面这个命令交给任务计划程序、`pm2` 或 NSSM 托管：

```bash
npm run schedule -- --run-on-start
```

这样即使机器重启，常驻调度也能自动恢复。
