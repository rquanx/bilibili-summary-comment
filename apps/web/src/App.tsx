import { startTransition, useDeferredValue, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Route, Routes, useLocation, useParams } from "react-router-dom";

type DashboardSummary = {
  activeCount: number;
  failedCount24h: number;
  succeededCount24h: number;
  latestUpdatedAt: string | null;
};

type DashboardRunItem = {
  runId: string;
  bvid: string | null;
  videoTitle: string | null;
  triggerSource: string | null;
  runStatus: string;
  currentStage: string | null;
  currentScope: string | null;
  currentAction: string | null;
  currentStatus: string | null;
  currentPageNo: number | null;
  currentPartTitle: string | null;
  lastMessage: string | null;
  lastErrorMessage: string | null;
  failedStep: string | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  logPath: string | null;
  summaryPath: string | null;
  pendingSummaryPath: string | null;
};

type VideoPart = {
  id: number;
  page_no: number;
  part_title: string;
  subtitle_path: string | null;
  summary_text: string | null;
  summary_text_processed: string | null;
  published: number;
  updated_at: string;
};

type PipelineDetailResponse = {
  video: {
    id: number;
    bvid: string;
    title: string;
    owner_name: string | null;
    page_count: number;
    publish_needs_rebuild: number;
    publish_rebuild_reason: string | null;
    updated_at: string;
  } | null;
  parts: VideoPart[];
  latestRun: DashboardRunItem | null;
  recentRuns: DashboardRunItem[];
  recentEvents: Array<{
    id: number;
    runId: string | null;
    pageNo: number | null;
    partTitle: string | null;
    scope: string;
    action: string;
    status: string;
    message: string | null;
    createdAt: string;
  }>;
};

type SchedulerStatus = {
  schedulerKey: string;
  status: string;
  healthy: boolean;
  mode: string | null;
  timezone: string | null;
  pid: number | null;
  hostname: string | null;
  summaryUsers: string | null;
  summaryConcurrency: number | null;
  currentTasks: string[];
  taskTimes: Record<string, string | null>;
  lastError: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  updatedAt: string | null;
};

type ActionAudit = {
  id: number;
  action: string;
  scope: string;
  triggerSource: string;
  bvid: string | null;
  runId: string | null;
  request: unknown;
  status: string;
  result: unknown;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type ActionResponse = {
  ok: boolean;
  auditId: number;
  action: string;
  scope: string;
  bvid?: string | null;
  runId?: string | null;
  result?: unknown;
  errorMessage?: string;
};

const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL ?? "").trim();

export default function App() {
  return (
    <div className="min-h-screen px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <Header />
        <RefreshBridge />
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/pipeline/:bvid" element={<PipelineDetailPage />} />
        </Routes>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header className="glass-panel overflow-hidden rounded-[1.8rem]">
      <div className="flex flex-col gap-5 bg-[linear-gradient(135deg,rgba(191,79,36,0.18),rgba(255,255,255,0))] px-6 py-6 sm:px-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">video pipeline</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Operations Console</h1>
          </div>
          <Link
            to="/"
            className="rounded-full border border-[var(--line)] bg-white/70 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)]"
          >
            Dashboard
          </Link>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-[var(--muted)] sm:text-base">
          Read live pipeline state, inspect failures, trigger recovery actions, and verify scheduler health from one place.
        </p>
      </div>
    </header>
  );
}

function RefreshBridge() {
  const queryClient = useQueryClient();
  const location = useLocation();

  useEffect(() => {
    const eventSource = new EventSource(buildApiUrl("/api/dashboard/events/stream"));
    const refresh = () => {
      startTransition(() => {
        void queryClient.invalidateQueries({
          predicate(query) {
            return Array.isArray(query.queryKey) && (query.queryKey[0] === "dashboard" || query.queryKey[0] === "scheduler");
          },
        });

        if (location.pathname.startsWith("/pipeline/")) {
          const bvid = decodeURIComponent(location.pathname.split("/").pop() ?? "");
          if (bvid) {
            void queryClient.invalidateQueries({
              queryKey: ["pipeline", bvid],
            });
            void queryClient.invalidateQueries({
              queryKey: ["audits", bvid],
            });
          }
        }
      });
    };

    eventSource.addEventListener("events", refresh);
    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => {
      eventSource.removeEventListener("events", refresh);
      eventSource.close();
    };
  }, [location.pathname, queryClient]);

  return null;
}

function DashboardPage() {
  const [filter, setFilter] = useState("");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const deferredFilter = useDeferredValue(filter.trim().toLowerCase());
  const queryClient = useQueryClient();

  const summaryQuery = useQuery({
    queryKey: ["dashboard", "summary"],
    queryFn: async () => fetchJson<{ ok: true; summary: DashboardSummary }>("/api/dashboard/summary"),
  });
  const activeQuery = useQuery({
    queryKey: ["dashboard", "active-pipelines"],
    queryFn: async () => fetchJson<{ ok: true; items: DashboardRunItem[] }>("/api/dashboard/active-pipelines?limit=100"),
  });
  const recentQuery = useQuery({
    queryKey: ["dashboard", "recent-runs"],
    queryFn: async () => fetchJson<{ ok: true; items: DashboardRunItem[] }>("/api/dashboard/recent-runs?limit=60"),
  });
  const schedulerQuery = useQuery({
    queryKey: ["scheduler", "status"],
    queryFn: async () => fetchJson<{ ok: true; status: SchedulerStatus }>("/api/scheduler/status"),
    refetchInterval: 5000,
  });
  const auditsQuery = useQuery({
    queryKey: ["audits", "all"],
    queryFn: async () => fetchJson<{ ok: true; items: ActionAudit[] }>("/api/actions/audits?limit=20"),
    refetchInterval: 5000,
  });

  const summary = summaryQuery.data?.summary;
  const scheduler = schedulerQuery.data?.status;
  const auditItems = auditsQuery.data?.items ?? [];
  const activeItems = (activeQuery.data?.items ?? []).filter((item) => matchesRunFilter(item, deferredFilter));
  const recentItems = (recentQuery.data?.items ?? []).filter((item) => matchesRunFilter(item, deferredFilter));
  const failedItems = recentItems.filter((item) => item.runStatus === "failed").slice(0, 12);

  async function runAction(actionKey: string, targetPath: string, body: Record<string, unknown>) {
    setPendingAction(actionKey);
    setActionMessage(null);

    const response = await postJson<ActionResponse>(targetPath, body);
    if (!response.ok) {
      setActionMessage(`Action failed: ${response.errorMessage || "unknown error"}`);
      setPendingAction(null);
      await refreshQueries(queryClient);
      return;
    }

    setActionMessage(`Action queued with audit #${response.auditId}`);
    setPendingAction(null);
    await refreshQueries(queryClient);
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="Active Pipelines" value={summary?.activeCount ?? 0} tone="accent" />
        <MetricCard title="Succeeded 24h" value={summary?.succeededCount24h ?? 0} tone="success" />
        <MetricCard title="Failed 24h" value={summary?.failedCount24h ?? 0} tone="danger" />
        <MetricCard title="Latest Update" value={formatDateTime(summary?.latestUpdatedAt)} tone="neutral" />
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">controls</p>
              <h2 className="mt-1 text-2xl font-semibold">Operator Actions</h2>
            </div>
            <label className="flex w-full max-w-sm flex-col gap-2 text-sm text-[var(--muted)]">
              Filter by `bvid` or title
              <input
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                }}
                className="rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
                placeholder="for example BV1xxxx"
              />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <ActionButton
              label="Run summary sweep"
              busy={pendingAction === "summary-sweep"}
              onClick={() => {
                void runAction("summary-sweep", "/api/actions/summary-sweep", {});
              }}
            />
            <ActionButton
              label="Run publish sweep"
              busy={pendingAction === "publish-sweep"}
              onClick={() => {
                if (!window.confirm("Run publish sweep now?")) {
                  return;
                }

                void runAction("publish-sweep", "/api/actions/publish-sweep", {
                  confirm: true,
                });
              }}
            />
          </div>

          {actionMessage ? (
            <div className="mt-4 rounded-2xl border border-[var(--line)] bg-white/70 px-4 py-3 text-sm text-[var(--muted)]">
              {actionMessage}
            </div>
          ) : null}
        </div>

        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">scheduler</p>
            <h2 className="text-2xl font-semibold">Daemon Status</h2>
          </div>
          <SchedulerStatusCard status={scheduler ?? null} />
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">active</p>
              <h3 className="text-xl font-semibold">Active Pipelines</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{activeItems.length} rows</span>
          </div>
          <RunTable items={activeItems} emptyText="No active pipelines right now." />
        </div>

        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">failures</p>
              <h3 className="text-xl font-semibold">Recent Failures</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{failedItems.length} rows</span>
          </div>
          <div className="flex flex-col gap-3">
            {failedItems.length === 0 ? (
              <EmptyState text="No recent failed runs." />
            ) : (
              failedItems.map((item) => (
                <Link
                  key={item.runId}
                  to={`/pipeline/${encodeURIComponent(item.bvid ?? "")}`}
                  className="rounded-[1.2rem] border border-[var(--line)] bg-white/70 px-4 py-4 transition hover:-translate-y-0.5 hover:border-[var(--accent)]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{item.videoTitle || item.bvid || "Unknown video"}</p>
                      <p className="mt-1 text-sm text-[var(--muted)]">{item.failedStep || item.currentStage || "failed"}</p>
                    </div>
                    {renderStatus(item.runStatus)}
                  </div>
                  <p className="mt-3 line-clamp-2 text-sm text-[var(--muted)]">{item.lastErrorMessage || item.lastMessage || "No error message"}</p>
                </Link>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">recent</p>
            <h3 className="text-xl font-semibold">Recent Runs</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">{recentItems.length} rows</span>
        </div>
        <RunTable items={recentItems} emptyText="No recent runs available." />
      </section>

      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">audits</p>
            <h3 className="text-xl font-semibold">Recent Manual Actions</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">{auditItems.length} rows</span>
        </div>
        <AuditList items={auditItems} emptyText="No manual operations recorded yet." />
      </section>
    </div>
  );
}

function PipelineDetailPage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const bvid = String(params.bvid ?? "").trim();

  const detailQuery = useQuery({
    queryKey: ["pipeline", bvid],
    enabled: Boolean(bvid),
    queryFn: async () => fetchJson<{ ok: true; detail: PipelineDetailResponse }>(`/api/dashboard/pipeline/${encodeURIComponent(bvid)}`),
  });
  const auditsQuery = useQuery({
    queryKey: ["audits", bvid],
    enabled: Boolean(bvid),
    queryFn: async () => fetchJson<{ ok: true; items: ActionAudit[] }>(`/api/actions/audits?bvid=${encodeURIComponent(bvid)}&limit=20`),
    refetchInterval: 5000,
  });

  const detail = detailQuery.data?.detail;
  const video = detail?.video;
  const auditItems = auditsQuery.data?.items ?? [];

  async function runAction(actionKey: string, targetPath: string, body: Record<string, unknown>) {
    setPendingAction(actionKey);
    setActionMessage(null);

    const response = await postJson<ActionResponse>(targetPath, body);
    if (!response.ok) {
      setActionMessage(`Action failed: ${response.errorMessage || "unknown error"}`);
      setPendingAction(null);
      await refreshQueries(queryClient, bvid);
      return;
    }

    setActionMessage(`Action accepted with audit #${response.auditId}`);
    setPendingAction(null);
    await refreshQueries(queryClient, bvid);
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <Link to="/" className="text-sm font-medium text-[var(--muted)] transition hover:text-[var(--accent)]">
          ← Back to dashboard
        </Link>
        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{video?.bvid || bvid}</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight">{video?.title || "Pipeline detail"}</h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--muted)]">
              {detail?.latestRun?.lastMessage || detail?.latestRun?.lastErrorMessage || "Inspect the latest run, page-level state, and recovery actions for this video."}
            </p>
          </div>
          <div className="grid min-w-[260px] gap-3 sm:grid-cols-2">
            <KeyValueCard label="Latest status" valueNode={renderStatus(detail?.latestRun?.runStatus || "unknown")} />
            <KeyValueCard label="Current stage" value={detail?.latestRun?.currentStage || "-"} />
            <KeyValueCard label="Latest update" value={formatDateTime(detail?.latestRun?.updatedAt)} />
            <KeyValueCard label="Rebuild flag" value={video?.publish_needs_rebuild ? video.publish_rebuild_reason || "yes" : "no"} />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <ActionButton
            label="Retry pipeline"
            busy={pendingAction === "retry"}
            onClick={() => {
              void runAction("retry", `/api/actions/pipeline/${encodeURIComponent(bvid)}/retry`, {});
            }}
          />
          <ActionButton
            label="Publish now"
            busy={pendingAction === "publish"}
            onClick={() => {
              if (!window.confirm("Run publish for this video now?")) {
                return;
              }

              void runAction("publish", `/api/actions/pipeline/${encodeURIComponent(bvid)}/publish`, {
                confirm: true,
              });
            }}
          />
          <ActionButton
            label="Mark rebuild"
            busy={pendingAction === "rebuild"}
            onClick={() => {
              if (!window.confirm("Mark this video for publish thread rebuild?")) {
                return;
              }

              void runAction("rebuild", `/api/actions/pipeline/${encodeURIComponent(bvid)}/rebuild-publish-thread`, {
                confirm: true,
              });
            }}
          />
        </div>

        {actionMessage ? (
          <div className="mt-4 rounded-2xl border border-[var(--line)] bg-white/70 px-4 py-3 text-sm text-[var(--muted)]">
            {actionMessage}
          </div>
        ) : null}
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">parts</p>
              <h3 className="text-xl font-semibold">Page Status</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{detail?.parts.length ?? 0} pages</span>
          </div>
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Title</th>
                  <th>Summary</th>
                  <th>Publish</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {(detail?.parts ?? []).map((part) => (
                  <tr key={part.id}>
                    <td className="font-semibold">P{part.page_no}</td>
                    <td>{part.part_title}</td>
                    <td>{part.summary_text_processed || part.summary_text ? "ready" : "pending"}</td>
                    <td>{Number(part.published) === 1 ? "published" : "pending"}</td>
                    <td>{formatDateTime(part.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">runs</p>
              <h3 className="text-xl font-semibold">Recent Runs</h3>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            {(detail?.recentRuns ?? []).map((run) => (
              <div key={run.runId} className="rounded-[1.2rem] border border-[var(--line)] bg-white/70 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold">{run.currentStage || run.currentScope || "pipeline"}</p>
                    <p className="mt-1 text-sm text-[var(--muted)]">{formatDateTime(run.updatedAt)}</p>
                  </div>
                  {renderStatus(run.runStatus)}
                </div>
                <p className="mt-3 text-sm text-[var(--muted)]">{run.lastErrorMessage || run.lastMessage || "-"}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">timeline</p>
            <h3 className="text-xl font-semibold">Recent Events</h3>
          </div>
          <div className="timeline flex flex-col gap-4">
            {(detail?.recentEvents ?? []).map((event) => (
              <div key={event.id} className="timeline-item rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
                <div className="flex flex-wrap items-center gap-3">
                  {renderStatus(event.status)}
                  <span className="text-sm font-semibold">{event.scope}/{event.action}</span>
                  <span className="text-sm text-[var(--muted)]">{formatDateTime(event.createdAt)}</span>
                  {event.pageNo ? <span className="text-sm text-[var(--muted)]">P{event.pageNo}</span> : null}
                </div>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{event.message || event.partTitle || "-"}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">audits</p>
              <h3 className="text-xl font-semibold">Recent Manual Actions</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{auditItems.length} rows</span>
          </div>
          <AuditList items={auditItems} emptyText="No manual actions recorded for this video." />
        </div>
      </section>
    </div>
  );
}

function SchedulerStatusCard({ status }: { status: SchedulerStatus | null }) {
  if (!status) {
    return <EmptyState text="Scheduler status is not available yet." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <KeyValueCard label="State" valueNode={renderStatus(status.healthy ? "running" : status.status)} />
      <KeyValueCard label="Current tasks" value={status.currentTasks.length > 0 ? status.currentTasks.join(", ") : "idle"} />
      <KeyValueCard label="Last heartbeat" value={formatDateTime(status.lastHeartbeatAt)} />
      <KeyValueCard label="Heartbeat age" value={formatDuration(status.heartbeatAgeMs)} />
      <KeyValueCard label="Concurrency" value={status.summaryConcurrency ? String(status.summaryConcurrency) : "-"} />
      <KeyValueCard label="Last error" value={status.lastError || "-"} />
    </div>
  );
}

function AuditList({
  items,
  emptyText,
}: {
  items: ActionAudit[];
  emptyText: string;
}) {
  if (items.length === 0) {
    return <EmptyState text={emptyText} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.id} className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-semibold">{item.action}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {item.bvid || item.scope} · audit #{item.id}
              </p>
            </div>
            {renderStatus(item.status)}
          </div>
          <p className="mt-3 text-sm text-[var(--muted)]">
            {item.errorMessage || describeAuditResult(item.result) || "No result details"}
          </p>
          <p className="mt-2 text-xs uppercase tracking-[0.16em] text-[var(--muted)]">{formatDateTime(item.createdAt)}</p>
        </div>
      ))}
    </div>
  );
}

function MetricCard({
  title,
  value,
  tone,
}: {
  title: string;
  value: string | number;
  tone: "accent" | "success" | "danger" | "neutral";
}) {
  const toneClass = {
    accent: "from-[rgba(191,79,36,0.2)] to-white/60",
    success: "from-[rgba(24,122,89,0.18)] to-white/60",
    danger: "from-[rgba(184,45,45,0.16)] to-white/60",
    neutral: "from-[rgba(23,33,43,0.08)] to-white/60",
  }[tone];

  return (
    <div className={`glass-panel rounded-[1.4rem] bg-gradient-to-br ${toneClass} p-5`}>
      <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">{title}</p>
      <p className="mt-4 text-3xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}

function KeyValueCard({
  label,
  value,
  valueNode,
}: {
  label: string;
  value?: string;
  valueNode?: ReactNode;
}) {
  return (
    <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">{label}</p>
      <div className="mt-3 text-sm font-medium">{valueNode ?? value ?? "-"}</div>
    </div>
  );
}

function ActionButton({
  label,
  busy,
  onClick,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)] disabled:cursor-wait disabled:opacity-60"
    >
      {busy ? "Working..." : label}
    </button>
  );
}

function RunTable({
  items,
  emptyText,
}: {
  items: DashboardRunItem[];
  emptyText: string;
}) {
  if (items.length === 0) {
    return <EmptyState text={emptyText} />;
  }

  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>Video</th>
            <th>Stage</th>
            <th>Latest message</th>
            <th>Status</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.runId}>
              <td>
                <Link to={`/pipeline/${encodeURIComponent(item.bvid ?? "")}`} className="group block">
                  <div className="font-semibold transition group-hover:text-[var(--accent)]">{item.videoTitle || item.bvid || "Unknown video"}</div>
                  <div className="mt-1 text-sm text-[var(--muted)]">{item.bvid || "-"} · {item.triggerSource || "cli"}</div>
                </Link>
              </td>
              <td>
                <div className="font-medium">{item.currentStage || "-"}</div>
                <div className="mt-1 text-sm text-[var(--muted)]">
                  {item.currentPageNo ? `P${item.currentPageNo}` : "-"}
                  {item.currentPartTitle ? ` · ${item.currentPartTitle}` : ""}
                </div>
              </td>
              <td className="max-w-[340px]">
                <div className="line-clamp-2 text-sm text-[var(--muted)]">{item.lastErrorMessage || item.lastMessage || "-"}</div>
              </td>
              <td>{renderStatus(item.runStatus)}</td>
              <td className="text-sm text-[var(--muted)]">{formatDateTime(item.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-[1.2rem] border border-dashed border-[var(--line)] bg-white/60 px-4 py-10 text-center text-sm text-[var(--muted)]">
      {text}
    </div>
  );
}

function renderStatus(status: string) {
  const normalized = String(status || "unknown").toLowerCase();
  const className = normalized === "running"
    ? "status-running"
    : normalized === "succeeded"
      ? "status-succeeded"
      : normalized === "failed"
        ? "status-failed"
        : normalized === "waiting"
          ? "status-waiting"
          : "status-skipped";

  return <span className={`status-pill ${className}`}>{normalized}</span>;
}

function buildApiUrl(targetPath: string): string {
  return API_BASE_URL ? `${API_BASE_URL}${targetPath}` : targetPath;
}

async function fetchJson<T>(targetPath: string): Promise<T> {
  const response = await fetch(buildApiUrl(targetPath));
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function postJson<T>(targetPath: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(buildApiUrl(targetPath), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return response.json() as Promise<T>;
}

async function refreshQueries(queryClient: ReturnType<typeof useQueryClient>, bvid: string | null = null) {
  await Promise.all([
    queryClient.invalidateQueries({
      predicate(query) {
        return Array.isArray(query.queryKey) && (query.queryKey[0] === "dashboard" || query.queryKey[0] === "scheduler" || query.queryKey[0] === "audits");
      },
    }),
    bvid
      ? queryClient.invalidateQueries({
        queryKey: ["pipeline", bvid],
      })
      : Promise.resolve(),
  ]);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  const candidate = new Date(value);
  if (Number.isNaN(candidate.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(candidate);
}

function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }

  if (value < 1000) {
    return `${value} ms`;
  }

  return `${(value / 1000).toFixed(1)} s`;
}

function matchesRunFilter(item: DashboardRunItem, filter: string): boolean {
  if (!filter) {
    return true;
  }

  const haystack = [
    item.bvid,
    item.videoTitle,
    item.currentStage,
    item.lastMessage,
    item.lastErrorMessage,
  ].join("\n").toLowerCase();

  return haystack.includes(filter);
}

function describeAuditResult(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }

  const payload = result as {
    ok?: unknown;
    marked?: unknown;
    uploads?: unknown;
    failures?: unknown;
    runs?: unknown;
    queued?: unknown;
    generatedPages?: unknown;
  };

  if (payload.marked === true) {
    return "Rebuild flag set.";
  }

  if (typeof payload.uploads === "number" || typeof payload.failures === "number" || typeof payload.runs === "number") {
    return `runs=${String(payload.runs ?? "-")}, uploads=${String(payload.uploads ?? "-")}, failures=${String(payload.failures ?? "-")}`;
  }

  if (typeof payload.queued === "number") {
    return `queued=${payload.queued}, failures=${String(payload.failures ?? "-")}`;
  }

  if (Array.isArray(payload.generatedPages)) {
    return `generated pages: ${payload.generatedPages.length}`;
  }

  return "";
}
