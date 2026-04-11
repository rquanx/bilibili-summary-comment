# 定时任务说明

这个项目现在提供一个基于 `node-cron` 的常驻调度入口，以及几类可以单独执行的脚本：

- `npm run login:bili`
- `npm run refresh:cookie`
- `npm run sync:users`
- `npm run cleanup:work`
- `npm run inspect:events`
- `npm run schedule`
- `npm run start`

## 1. 先准备可刷新的 B 站授权

如果你希望“自动刷新 cookie”，不能只依赖现成的 `cookie.txt`。

自动刷新依赖 `@renmu/bili-api` 的 TV 登录返回内容，也就是：

- `access_token`
- `refresh_token`
- 当前可用的 cookie 信息

默认情况下，项目会把这些状态保存在仓库根目录：

```text
bili-auth.json
```

最简单的初始化方式：

```bash
npm run login:bili
```

运行后脚本会输出二维码 URL。扫码登录成功后会自动写入：

- `bili-auth.json`
- `cookie.txt`

后续定时刷新和总结流水线都会继续复用这两个文件。

## 2. 调度相关环境变量

建议至少在 `.env` 里配置：

```dotenv
SUMMARY_USERS=https://space.bilibili.com/123456,https://space.bilibili.com/234567
CRON_TIMEZONE=Asia/Shanghai
```

支持的调度相关变量：

- `SUMMARY_USERS`
  逗号或换行分隔的 Bilibili 用户空间链接，或直接填写 UID。
- `SUMMARY_SINCE_HOURS`
  扫描最近多少小时的投稿，默认 `24`。
- `SUMMARY_PIPELINE_CONCURRENCY`
  同时最多跑多少条视频流水线，默认 `3`。
- `BILI_AUTH_FILE`
  TV 登录授权文件路径，默认 `bili-auth.json`。
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
- `SERVER_CHAN_SEND_KEY`
  可选。转写连续失败后，用于发送 ServerChan 通知。

命令行参数也可以覆盖这些环境变量，例如：

```bash
npm run schedule -- --summary-concurrency 2 --timezone Asia/Shanghai
```

## 3. 调度行为

`npm run schedule` 启动后，会注册这 3 个定时任务：

- 每小时整点：
  扫描 `SUMMARY_USERS` 最近 `SUMMARY_SINCE_HOURS` 小时投稿，并对命中的视频执行完整流水线，默认自动发布。
- 每天 `03:15`：
  检查 `bili-auth.json` 是否超过 `BILI_REFRESH_DAYS` 天未更新；如果过期，则刷新 cookie。
- 每天 `03:45`：
  清理数据库里最后扫描时间早于 `WORK_CLEANUP_DAYS` 天之前的 `work/<BV号>` 目录。

说明：

- “每 30 天刷新一次”是通过“每天检查 + 超过阈值才执行”实现的，比直接写成“每月某一天”更接近真实的 30 天周期。
- 扫描用户最近投稿时，命中的视频会复用现有 `run-video-pipeline` 流程，所以已经做过总结的分 P 会自动跳过。
- 扫描用户最近投稿时，默认会自动发布待发布总结。
- 同一 UP、同一场录播的不同标题变体会串行排队，并优先处理更早上传的版本，便于后续版本复用总结和评论线程。
- 清理任务不会删除数据库记录，只会删除 `work` 目录里的过期文件。
- 如果清理任务触发时总结任务还在运行，当前这轮清理会主动跳过。

## 4. 常用命令

手动初始化 TV 登录：

```bash
npm run login:bili
```

手动刷新 cookie：

```bash
npm run refresh:cookie
```

手动扫描一轮最近投稿：

```bash
npm run sync:users
```

手动清理旧工作目录：

```bash
npm run cleanup:work
```

查看最近事件与待处理分 P：

```bash
npm run inspect:events -- --since-hours 24 --limit 100
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
npm run start
```

它等价于：

```bash
npm run schedule -- --run-on-start
```

## 5. 部署建议

Windows 下，建议把下面这个命令交给任务计划程序、`pm2`、NSSM 或其他进程守护工具：

```bash
npm run start
```

这样即使机器重启，常驻调度也能自动恢复。

如果你使用的是 `npm run build` 生成的 `dist/`：

- 构建脚本会复制运行时需要的 `.env`、cookie、授权文件、SQLite 和 `sql/`
- 调度器在 `dist` 环境里会优先直接调用编译后的 `run-video-pipeline.js`
- 因此适合做一个相对稳定的部署快照

## 6. 建议的检查顺序

如果常驻调度没有按预期工作，建议按这个顺序排查：

1. `npm run login:bili` 是否已经成功生成 `bili-auth.json` 和 `cookie.txt`
2. `.env` 里的 `SUMMARY_USERS`、`CRON_TIMEZONE` 是否配置正确
3. `npm run sync:users` 能否手工跑通
4. `npm run inspect:events -- --since-hours 24 --limit 100` 是否能看到最近事件
5. `npm run start` 启动日志里是否打印了 cron 计划和失败信息
