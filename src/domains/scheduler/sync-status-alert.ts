import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sendServerChanNotification } from "../subtitle/notifier";

export const SYNC_TASKS = {
  "subtitle-sync": "慎勇者字幕／直播总结同步",
  "viewpoint-sync": "慎勇者每日观点同步",
  "knowledge-sync": "慎勇者月度知识同步",
  "notification-test": "慎勇者同步告警测试",
} as const;

type SyncTask = keyof typeof SYNC_TASKS;
type SyncStatus = "failed" | "succeeded" | "requires-release";
interface AlertState {
  status: SyncStatus;
  failureSince: string | null;
  notifiedAt: string | null;
  updatedAt: string;
}

export async function reportSyncStatus({
  task, status, logPath, stateDirectory, enabled = false, dryRun = false,
  now = new Date(), send = sendServerChanNotification,
}: {
  task: SyncTask;
  status: SyncStatus;
  logPath: string;
  stateDirectory: string;
  enabled?: boolean;
  dryRun?: boolean;
  now?: Date;
  send?: typeof sendServerChanNotification;
}) {
  if (!Object.hasOwn(SYNC_TASKS, task) || !["failed", "succeeded", "requires-release"].includes(status)) {
    throw new Error("Invalid sync task or status");
  }
  if (!enabled && !dryRun) return { action: "disabled" };
  const statePath = path.join(stateDirectory, `${task}.json`);
  const previous: AlertState | null = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
  const timestamp = now.toISOString();
  const failed = status !== "succeeded";
  const shouldNotify = failed
    ? previous?.status !== status || !previous.notifiedAt ||
      now.getTime() - Date.parse(previous.notifiedAt) >= 24 * 60 * 60 * 1000
    : previous?.status !== "succeeded" && Boolean(previous?.notifiedAt);
  const notification = {
    title: `${status === "requires-release" ? "等待完整发布" : failed ? "同步失败" : "同步恢复"}：${SYNC_TASKS[task]}`,
    desp: [
      `任务：${SYNC_TASKS[task]}`,
      `主机：${os.hostname()}`,
      `时间：${timestamp}`,
      status === "requires-release"
        ? "主观点发生变化，已冻结完整发布候选。新增内容尚未上线；需完成来源／条件／当前简报复核、最终评测及完整发布。重复运行小观点增量任务不能解决。候选索引：.tmp/viewpoint-incremental-cycle/pending-full-release.json（慎勇者项目目录内）。"
        : failed ? "线上内容可能未更新。请检查认证、来源处理、质量门禁及发布日志。" : "任务已重新执行成功。",
      `日志：${logPath}`,
      "通知不包含 Token、数据库连接串或原始命令输出。",
    ].join("\n\n"),
  };
  if (dryRun) return { action: "dry-run", shouldNotify, notification };

  const next: AlertState = {
    status,
    failureSince: failed ? (previous?.status === status ? previous.failureSince : timestamp) : null,
    notifiedAt: failed && previous?.status === status ? previous.notifiedAt : null,
    updatedAt: timestamp,
  };
  const persist = () => {
    fs.mkdirSync(stateDirectory, { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(temporary, statePath);
  };
  // Keep the failure episode until delivery succeeds, so a later run can retry.
  if (failed) persist();
  if (shouldNotify) {
    const result = await send(notification);
    if (result.skipped) return { action: "missing-send-key" };
    next.notifiedAt = failed ? timestamp : null;
  }
  persist();
  return { action: shouldNotify ? "notified" : "recorded", status };
}
