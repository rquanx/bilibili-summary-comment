# 慎勇者线上同步告警

此接入覆盖 `D:/develop/code/github/shenyongzhe/scripts/run-scheduled-{sync,viewpoints,knowledge}.ps1` 三个既有 Windows 任务。它们在成功／失败出口调用本项目的 `src/commands/report-sync-status.ts`，无需重新构建或启动总结项目 Docker 容器。

通知复用本项目 `.env` 中的 `SERVER_CHAN_SEND_KEY`。只有明确启用 `SYNC_SERVERCHAN_ALERTS_ENABLED=true` 才会发送；无需把密钥复制进慎勇者项目。

2026-11-14 已依用户确认启用上述三个任务的失败／恢复告警；用户选择不发送测试通知。本次只验证配置和不发送消息的预览，未进行真实投递测试。现有 Windows 任务下次执行时直接读取此开关，无需重启。

- 首次失败立即通知，包括认证失效、来源刷新失败、质量门禁失败、需要完整观点发布及其他非零退出。
- 2026-11-16 起，已成功冻结主观点候选、需要走完整发布时使用独立 `requires-release` 状态，标题为“等待完整发布”，附固定交接索引路径。任务仍返回非零退出码 3，不会误报已上线；普通失败转为待发布也不会发送恢复通知。
- 持续失败按任务去重，每 24 小时最多提醒一次；实际发送仍以任务下一次运行时间为准。
- 已通知的失败恢复后发送一次恢复通知；日常成功不通知。
- Server 酱请求最长等待 15 秒，HTTP 成功且接口业务结果成功才记录为已发送。失败保留未送达状态，在该任务下一次运行时重试。
- 状态持久化在 `work/logs/sync-alerts/<task>.json`，由各任务既有互斥锁避免同任务并发。通知故障写回任务日志，不改变同步任务原本的退出状态。
- 只发送任务名、主机、时间、日志路径和固定排查建议，不发送密钥、连接串或原始异常内容。

预览消息（不发送，也不改状态）：

```bash
node --disable-warning=ExperimentalWarning --import tsx src/commands/report-sync-status.ts \
  --task viewpoint-sync --status failed --log-path D:/develop/code/github/shenyongzhe/logs/viewpoint-sync/example.log --dry-run
```

启用后的独立测试任务名为 `notification-test`，不影响三个真实任务的去重记录。真实测试发送也须先确认通知接收范围。

此方案监测已启动任务的完成结果，不是独立的调度心跳探针；电脑关机、任务被禁用或进程在处理出口前被强杀时，无法由该进程发送告警。没有新直播且任务正常完成不会误报。
