import { startTransition, useDeferredValue, useEffect, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
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

type PipelineEventItem = {
  id: number;
  runId: string | null;
  bvid: string | null;
  videoTitle: string | null;
  pageNo: number | null;
  cid: number | null;
  partTitle: string | null;
  scope: string;
  action: string;
  status: string;
  message: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
};

type PagedResponse<T> = {
  ok: true;
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

type FailureQueueItem = DashboardRunItem & {
  failureCategory: string;
  resolution: "retryable" | "manual" | "inspect";
  resolutionReason: string;
  failureSignature: string;
};

type FailureGroupItem = {
  key: string;
  failedStep: string | null;
  failureCategory: string;
  resolution: "retryable" | "manual" | "inspect";
  resolutionReason: string;
  count: number;
  latestRunId: string;
  latestBvid: string | null;
  latestVideoTitle: string | null;
  latestMessage: string | null;
  latestUpdatedAt: string;
};

type RecoveryCandidateItem = DashboardRunItem & {
  staleForMs: number;
  lockExists: boolean;
  lockStale: boolean;
  lockPath: string;
  recoveryState: "missing-lock" | "orphaned-lock" | "stalled";
  recoveryReason: string;
  recommendedAction: "retry-now" | "cancel" | "inspect";
};

type AttentionItem = {
  kind: "scheduler-missing" | "scheduler-heartbeat" | "scheduler-status" | "stalled-run";
  severity: "warning" | "critical";
  title: string;
  message: string;
  runId: string | null;
  bvid: string | null;
  currentStage: string | null;
  status: string | null;
  updatedAt: string | null;
  staleForMs: number | null;
};

type DashboardHealthSnapshot = {
  attentionCount: number;
  criticalCount: number;
  warningCount: number;
  staleRunningCount: number;
  schedulerHealthy: boolean;
  schedulerStatus: string;
  schedulerLastHeartbeatAt: string | null;
  schedulerHeartbeatAgeMs: number | null;
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
  recentEvents: PipelineEventItem[];
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

type ManagedSettings = {
  scheduler: {
    authFile: string;
    cookieFile: string | null;
    timezone: string | null;
    summaryUsers: string;
    summarySinceHours: number;
    summaryConcurrency: number;
    retryFailuresLimit: number;
    retryFailuresSinceHours: number;
    retryFailuresMaxRecent: number;
    retryFailuresWindowHours: number;
    zombieRecoveryEnabled: boolean;
    zombieRecoveryStaleMs: number;
    zombieRecoveryLimit: number;
    zombieRecoveryMaxRecent: number;
    zombieRecoveryWindowHours: number;
    zombieRecoveryRetry: boolean;
    zombieRecoveryStates: string;
    refreshDays: number;
    cleanupDays: number;
    gapCheckSinceHours: number;
    gapThresholdSeconds: number;
    summaryCron: string;
    publishCron: string;
    gapCheckCron: string;
    retryFailuresCron: string;
    zombieRecoveryCron: string;
    refreshCron: string;
    cleanupCron: string;
  };
  summary: {
    model: string;
    apiBaseUrl: string;
    apiFormat: "auto" | "responses" | "openai-chat" | "anthropic-messages";
    promptConfigPath: string | null;
    promptConfigContent: string | null;
  };
  publish: {
    appendCooldownMinMs: number;
    appendCooldownMaxMs: number;
    rebuildCooldownMinMs: number;
    rebuildCooldownMaxMs: number;
    maxConcurrent: number;
    healthcheckSinceHours: number;
    includeRecentPublishedHealthcheck: boolean;
    stopOnFirstFailure: boolean;
    rebuildPriority: "append-first" | "rebuild-first";
    cooldownOnlyWhenCommentsCreated: boolean;
  };
};

type ManagedSettingDefinition = {
  key: string;
  group: "scheduler" | "summary" | "publish";
  label: string;
  description: string;
  input: "text" | "textarea" | "number" | "select";
  options?: string[];
  requiresRestart: boolean;
  effectiveScope: string;
};

type SchedulerPlan = {
  timezone: string;
  tasks: Array<{
    key: string;
    label: string;
    cron: string;
    description: string;
    requiresRestart: boolean;
  }>;
};

type ConfigHistoryItem = {
  id: number;
  action: string;
  triggerSource: string;
  status: string;
  request: unknown;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  updated: boolean;
  reason: string | null;
  restoredFromAuditId: number | null;
  changedKeys: string[];
  restartRequiredKeys: string[];
  changes: Array<{
    key: string;
    previousValue: unknown;
    nextValue: unknown;
    requiresRestart: boolean;
    effectiveScope: string;
  }>;
  settings: ManagedSettings | null;
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
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/failures" element={<FailuresPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="/settings" element={<SettingsPage />} />
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
          <nav className="flex flex-wrap gap-2">
            <HeaderLink to="/" label="Dashboard" />
            <HeaderLink to="/runs" label="Runs" />
            <HeaderLink to="/failures" label="Failures" />
            <HeaderLink to="/health" label="Health" />
            <HeaderLink to="/settings" label="Settings" />
          </nav>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-[var(--muted)] sm:text-base">
          Read live pipeline state, inspect failures, trigger recovery actions, and verify scheduler health from one place.
        </p>
      </div>
    </header>
  );
}

function HeaderLink({
  to,
  label,
}: {
  to: string;
  label: string;
}) {
  return (
    <Link
      to={to}
      className="rounded-full border border-[var(--line)] bg-white/70 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)]"
    >
      {label}
    </Link>
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
            return Array.isArray(query.queryKey) && (query.queryKey[0] === "dashboard" || query.queryKey[0] === "scheduler" || query.queryKey[0] === "settings");
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
  const failureQueueQuery = useQuery({
    queryKey: ["dashboard", "failure-queue"],
    queryFn: async () => fetchJson<{ ok: true; items: FailureQueueItem[] }>("/api/dashboard/failure-queue?limit=16"),
  });
  const failureGroupsQuery = useQuery({
    queryKey: ["dashboard", "failure-groups"],
    queryFn: async () => fetchJson<{ ok: true; items: FailureGroupItem[] }>("/api/dashboard/failure-groups?limit=8"),
  });
  const healthQuery = useQuery({
    queryKey: ["dashboard", "health"],
    queryFn: async () => fetchJson<{ ok: true; snapshot: DashboardHealthSnapshot; items: AttentionItem[] }>("/api/dashboard/health?attentionLimit=8"),
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
  const failureQueueItems = (failureQueueQuery.data?.items ?? []).filter((item) => matchesRunFilter(item, deferredFilter));
  const failureGroupItems = failureGroupsQuery.data?.items ?? [];
  const healthSnapshot = healthQuery.data?.snapshot;
  const attentionItems = healthQuery.data?.items ?? [];

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
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard title="Active Pipelines" value={summary?.activeCount ?? 0} tone="accent" />
        <MetricCard title="Succeeded 24h" value={summary?.succeededCount24h ?? 0} tone="success" />
        <MetricCard title="Failed 24h" value={summary?.failedCount24h ?? 0} tone="danger" />
        <MetricCard title="Attention" value={healthSnapshot?.attentionCount ?? 0} tone={(healthSnapshot?.criticalCount ?? 0) > 0 ? "danger" : "neutral"} />
        <MetricCard title="Latest Update" value={formatDateTime(summary?.latestUpdatedAt)} tone="neutral" />
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr_0.8fr_0.9fr]">
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
            <ActionButton
              label="Retry retryable failures"
              busy={pendingAction === "retry-failures"}
              onClick={() => {
                if (!window.confirm("Retry the latest retryable failed pipelines now?")) {
                  return;
                }

                void runAction("retry-failures", "/api/actions/retry-failures", {
                  confirm: true,
                  limit: 5,
                  maxRecentRetries: 1,
                  retryWindowHours: 6,
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

        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">attention</p>
              <h2 className="text-2xl font-semibold">Health Watch</h2>
            </div>
            <span className="text-sm text-[var(--muted)]">{attentionItems.length} items</span>
          </div>
          <HealthWatchCard snapshot={healthSnapshot ?? null} items={attentionItems} />
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
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">hotspots</p>
              <h3 className="text-xl font-semibold">Failure Groups</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{failureGroupItems.length} groups</span>
          </div>
          <FailureGroupList items={failureGroupItems} />
        </div>
      </section>

      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">queue</p>
            <h3 className="text-xl font-semibold">Failure Queue</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">{failureQueueItems.length} items</span>
        </div>
        <FailureQueueList
          items={failureQueueItems}
          pendingAction={pendingAction}
          onRetry={(item) => {
            if (!item.bvid) {
              return;
            }

            void runAction(`retry-${item.bvid}`, `/api/actions/pipeline/${encodeURIComponent(item.bvid)}/retry`, {});
          }}
        />
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

function FailuresPage() {
  const [filter, setFilter] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const deferredFilter = useDeferredValue(filter.trim().toLowerCase());
  const queryClient = useQueryClient();
  const failureQueueQuery = useQuery({
    queryKey: ["dashboard", "failure-queue", "page"],
    queryFn: async () => fetchJson<{ ok: true; items: FailureQueueItem[] }>("/api/dashboard/failure-queue?limit=100"),
  });
  const failureGroupsQuery = useQuery({
    queryKey: ["dashboard", "failure-groups", "page"],
    queryFn: async () => fetchJson<{ ok: true; items: FailureGroupItem[] }>("/api/dashboard/failure-groups?limit=24"),
  });
  const auditsQuery = useQuery({
    queryKey: ["audits", "failures-page"],
    queryFn: async () => fetchJson<{ ok: true; items: ActionAudit[] }>("/api/actions/audits?limit=30"),
    refetchInterval: 5000,
  });
  const failureQueueItems = (failureQueueQuery.data?.items ?? []).filter((item) => matchesRunFilter(item, deferredFilter));
  const failureGroupItems = failureGroupsQuery.data?.items ?? [];
  const auditItems = auditsQuery.data?.items ?? [];

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

    setActionMessage(`Action accepted with audit #${response.auditId}`);
    setPendingAction(null);
    await refreshQueries(queryClient);
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">phase 3</p>
            <h2 className="mt-1 text-2xl font-semibold">Failure Queue</h2>
          </div>
          <label className="flex w-full max-w-sm flex-col gap-2 text-sm text-[var(--muted)]">
            Filter by `bvid` or title
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
              placeholder="for example BV1xxxx"
            />
          </label>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <ActionButton
            label="Retry retryable failures"
            busy={pendingAction === "retry-failures"}
            onClick={() => {
              if (!window.confirm("Retry the latest retryable failed pipelines now?")) {
                return;
              }

              void runAction("retry-failures", "/api/actions/retry-failures", {
                confirm: true,
                limit: 5,
                maxRecentRetries: 1,
                retryWindowHours: 6,
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

      <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">clusters</p>
              <h3 className="text-xl font-semibold">Failure Groups</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{failureGroupItems.length} groups</span>
          </div>
          <FailureGroupList items={failureGroupItems} />
        </div>

        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">items</p>
              <h3 className="text-xl font-semibold">Failure Queue</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{failureQueueItems.length} items</span>
          </div>
          <FailureQueueList
            items={failureQueueItems}
            pendingAction={pendingAction}
            onRetry={(item) => {
              if (!item.bvid) {
                return;
              }

              void runAction(`retry-${item.bvid}`, `/api/actions/pipeline/${encodeURIComponent(item.bvid)}/retry`, {});
            }}
          />
        </div>
      </section>

      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">audits</p>
            <h3 className="text-xl font-semibold">Recent Recovery Actions</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">{auditItems.length} rows</span>
        </div>
        <AuditList items={auditItems} emptyText="No recovery actions recorded yet." />
      </section>
    </div>
  );
}

function HealthPage() {
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const healthQuery = useQuery({
    queryKey: ["dashboard", "health", "page"],
    queryFn: async () => fetchJson<{ ok: true; snapshot: DashboardHealthSnapshot; items: AttentionItem[] }>("/api/dashboard/health?attentionLimit=20"),
  });
  const schedulerQuery = useQuery({
    queryKey: ["scheduler", "status", "page"],
    queryFn: async () => fetchJson<{ ok: true; status: SchedulerStatus }>("/api/scheduler/status"),
    refetchInterval: 5000,
  });
  const activeQuery = useQuery({
    queryKey: ["dashboard", "active-pipelines", "health-page"],
    queryFn: async () => fetchJson<{ ok: true; items: DashboardRunItem[] }>("/api/dashboard/active-pipelines?limit=100"),
  });
  const recoveryQuery = useQuery({
    queryKey: ["dashboard", "recovery-candidates"],
    queryFn: async () => fetchJson<{ ok: true; items: RecoveryCandidateItem[] }>("/api/dashboard/recovery-candidates?limit=20"),
    refetchInterval: 5000,
  });

  const snapshot = healthQuery.data?.snapshot ?? null;
  const attentionItems = healthQuery.data?.items ?? [];
  const scheduler = schedulerQuery.data?.status ?? null;
  const activeItems = activeQuery.data?.items ?? [];
  const recoveryItems = recoveryQuery.data?.items ?? [];

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

    setActionMessage(`Action accepted with audit #${response.auditId}`);
    setPendingAction(null);
    await refreshQueries(queryClient);
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="Attention" value={snapshot?.attentionCount ?? 0} tone={(snapshot?.criticalCount ?? 0) > 0 ? "danger" : "neutral"} />
        <MetricCard title="Critical" value={snapshot?.criticalCount ?? 0} tone="danger" />
        <MetricCard title="Warnings" value={snapshot?.warningCount ?? 0} tone="neutral" />
        <MetricCard title="Stalled Runs" value={snapshot?.staleRunningCount ?? 0} tone="accent" />
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.8fr_1.2fr]">
        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">scheduler</p>
            <h2 className="text-2xl font-semibold">Daemon Health</h2>
          </div>
          <SchedulerStatusCard status={scheduler} />
        </div>

        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">attention</p>
            <h2 className="text-2xl font-semibold">Attention Queue</h2>
          </div>
          <HealthWatchCard snapshot={snapshot} items={attentionItems} />
        </div>
      </section>

      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">recovery</p>
            <h3 className="text-xl font-semibold">Zombie Recovery Candidates</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">{recoveryItems.length} rows</span>
        </div>
        {actionMessage ? (
          <div className="mb-4 rounded-2xl border border-[var(--line)] bg-white/70 px-4 py-3 text-sm text-[var(--muted)]">
            {actionMessage}
          </div>
        ) : null}
        <RecoveryCandidateList
          items={recoveryItems}
          pendingAction={pendingAction}
          onRecover={(item) => {
            if (!item.bvid) {
              return;
            }

            if (!window.confirm(`Recover zombie pipeline ${item.bvid} now? This will mark the stale run failed and queue a retry.`)) {
              return;
            }

            void runAction(`recover-${item.bvid}`, `/api/actions/pipeline/${encodeURIComponent(item.bvid)}/recover-zombie`, {
              confirm: true,
              retry: true,
              staleMs: 15 * 60 * 1000,
              reason: "health-page-zombie-recovery",
            });
          }}
          onCancel={(item) => {
            if (!item.bvid) {
              return;
            }

            if (!window.confirm(`Cancel stale pipeline ${item.bvid} now?`)) {
              return;
            }

            void runAction(`cancel-${item.bvid}`, `/api/actions/pipeline/${encodeURIComponent(item.bvid)}/cancel`, {
              reason: "health-page-stale-cancel",
            });
          }}
        />
      </section>

      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">running</p>
            <h3 className="text-xl font-semibold">Active Pipelines</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">{activeItems.length} rows</span>
        </div>
        <RunTable items={activeItems} emptyText="No active pipelines right now." />
      </section>
    </div>
  );
}

function SettingsPage() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ManagedSettings | null>(null);
  const [pendingSave, setPendingSave] = useState(false);
  const [pendingRollbackId, setPendingRollbackId] = useState<number | null>(null);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: async () => fetchJson<{ ok: true; settings: ManagedSettings; definitions: ManagedSettingDefinition[]; schedule: SchedulerPlan }>("/api/settings"),
  });
  const historyQuery = useQuery({
    queryKey: ["settings", "history"],
    queryFn: async () => fetchJson<{ ok: true; items: ConfigHistoryItem[] }>("/api/settings/history?limit=30"),
    refetchInterval: 5000,
  });
  const schedulerQuery = useQuery({
    queryKey: ["scheduler", "status", "settings"],
    queryFn: async () => fetchJson<{ ok: true; status: SchedulerStatus }>("/api/scheduler/status"),
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (!settingsQuery.data?.settings) {
      return;
    }

    setDraft(settingsQuery.data.settings);
  }, [settingsQuery.data?.settings]);

  const definitions = settingsQuery.data?.definitions ?? [];
  const schedule = settingsQuery.data?.schedule ?? null;
  const settings = settingsQuery.data?.settings ?? null;
  const configHistory = historyQuery.data?.items ?? [];
  const scheduler = schedulerQuery.data?.status ?? null;
  const dirty = draft && settings ? JSON.stringify(draft) !== JSON.stringify(settings) : false;
  const pendingRestartAudit = configHistory.find((item) => item.restartRequiredKeys.length > 0);
  const schedulerRestartPending = isSchedulerRestartPending(scheduler, pendingRestartAudit);

  async function saveSettings() {
    if (!draft) {
      return;
    }

    setPendingSave(true);
    setMessage(null);
    const response = await putJson<ActionResponse & {
      result?: {
        changedKeys?: string[];
        restartRequiredKeys?: string[];
      };
    }>("/api/settings", draft as unknown as Record<string, unknown>);

    if (!response.ok) {
      setPendingSave(false);
      setMessage(`Save failed: ${response.errorMessage || "unknown error"}`);
      return;
    }

    const changedKeys = Array.isArray(response.result?.changedKeys) ? response.result.changedKeys : [];
    const restartKeys = Array.isArray(response.result?.restartRequiredKeys) ? response.result.restartRequiredKeys : [];
    setPendingSave(false);
    setMessage(
      changedKeys.length > 0
        ? `Saved ${changedKeys.length} setting(s) with audit #${response.auditId}${restartKeys.length > 0 ? ". Some changes require scheduler restart." : ""}`
        : `No effective change detected. Audit #${response.auditId}`,
    );
    await Promise.all([
      refreshQueries(queryClient),
      queryClient.invalidateQueries({
        queryKey: ["settings"],
      }),
    ]);
  }

  async function rollbackToHistory(item: ConfigHistoryItem) {
    if (!item.id) {
      return;
    }

    setPendingRollbackId(item.id);
    setMessage(null);
    const response = await postJson<ActionResponse & {
      result?: {
        restoredFromAuditId?: number;
      };
    }>("/api/settings/rollback", {
      auditId: item.id,
    });

    if (!response.ok) {
      setPendingRollbackId(null);
      setMessage(`Rollback failed: ${response.errorMessage || "unknown error"}`);
      return;
    }

    setPendingRollbackId(null);
    setMessage(`Rolled back using audit #${item.id}. New audit #${response.auditId}.`);
    await Promise.all([
      refreshQueries(queryClient),
      queryClient.invalidateQueries({
        queryKey: ["settings"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["settings", "history"],
      }),
    ]);
  }

  async function requestSchedulerRestart() {
    setPendingRestart(true);
    setMessage(null);
    const response = await postJson<ActionResponse & {
      result?: {
        ownerPid?: number | null;
      };
    }>("/api/scheduler/restart", {
      confirm: true,
    });

    setPendingRestart(false);
    if (!response.ok) {
      setMessage(`Scheduler restart request failed: ${response.errorMessage || "unknown error"}`);
      return;
    }

    const ownerPid = typeof response.result?.ownerPid === "number" ? response.result.ownerPid : null;
    setMessage(`Restart signal sent with audit #${response.auditId}${ownerPid ? ` to pid ${ownerPid}` : ""}. The scheduler should come back under its supervisor.`);
    await refreshQueries(queryClient);
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">phase 4</p>
            <h2 className="mt-1 text-2xl font-semibold">Managed Runtime Settings</h2>
            <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
              Scheduler sweep parameters, summary model settings, and publish cooldown strategy now live in SQLite instead of scattered environment defaults.
              Timezone and cron plan changes still require a scheduler restart; task parameters apply on the next matching run.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            <ActionButton
              label="Request scheduler restart"
              busy={pendingRestart}
              onClick={() => {
                if (!window.confirm("Send a restart signal to the running scheduler now? This expects the process to be managed by a supervisor.")) {
                  return;
                }

                void requestSchedulerRestart();
              }}
            />
            <ActionButton
              label="Reset draft"
              busy={pendingSave || pendingRestart}
              onClick={() => {
                if (settings) {
                  setDraft(settings);
                  setMessage(null);
                }
              }}
            />
            <ActionButton
              label="Save settings"
              busy={pendingSave || pendingRestart}
              onClick={() => {
                void saveSettings();
              }}
            />
          </div>
        </div>
        {message ? (
          <div className="mt-4 rounded-2xl border border-[var(--line)] bg-white/70 px-4 py-3 text-sm text-[var(--muted)]">
            {message}
          </div>
        ) : null}
        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard title="Dirty Fields" value={dirty ? "yes" : "no"} tone={dirty ? "accent" : "neutral"} />
          <MetricCard title="Cron Timezone" value={schedule?.timezone ?? "system"} tone="neutral" />
          <MetricCard title="Config Audits" value={configHistory.length} tone="success" />
          <MetricCard title="Restart Required" value={schedulerRestartPending ? "yes" : "no"} tone={schedulerRestartPending ? "danger" : "neutral"} />
        </div>
        <div className="mt-5 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">Restart state</p>
              {schedulerRestartPending ? <span className="status-pill status-failed">pending</span> : <span className="status-pill status-succeeded">clear</span>}
            </div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              {schedulerRestartPending
                ? `Latest restart-scoped config audit is #${pendingRestartAudit?.id ?? "-"} and the current scheduler has not restarted after that change yet.`
                : "No pending scheduler restart is detected from the current config history."}
            </p>
          </div>
          <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">Running daemon</p>
              {scheduler?.healthy ? <span className="status-pill status-succeeded">healthy</span> : <span className="status-pill status-waiting">{scheduler?.status || "unknown"}</span>}
            </div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              {scheduler?.pid ? `pid ${scheduler.pid}` : "No active scheduler pid is recorded."}
              {scheduler?.mode ? ` · mode ${scheduler.mode}` : ""}
              {scheduler?.startedAt ? ` · started ${formatDateTime(scheduler.startedAt)}` : ""}
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">scheduler</p>
            <h3 className="text-xl font-semibold">Sweep Settings</h3>
          </div>
          <ManagedSettingsGroup
            definitions={definitions.filter((item) => item.group === "scheduler")}
            draft={draft}
            onChange={setDraft}
          />
        </div>

        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">cron</p>
            <h3 className="text-xl font-semibold">Schedule Plan</h3>
          </div>
          <SchedulerPlanCard schedule={schedule} />
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">summary</p>
            <h3 className="text-xl font-semibold">Inference Settings</h3>
          </div>
          <ManagedSettingsGroup
            definitions={definitions.filter((item) => item.group === "summary")}
            draft={draft}
            onChange={setDraft}
          />
        </div>

        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">publish</p>
            <h3 className="text-xl font-semibold">Cooldown Strategy</h3>
          </div>
          <ManagedSettingsGroup
            definitions={definitions.filter((item) => item.group === "publish")}
            draft={draft}
            onChange={setDraft}
          />
        </div>
      </section>

      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">history</p>
            <h3 className="text-xl font-semibold">Config History</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">{configHistory.length} rows</span>
        </div>
        <ConfigHistoryList
          items={configHistory}
          pendingRollbackId={pendingRollbackId}
          onRollback={(item) => {
            if (!window.confirm(`Rollback settings to audit #${item.id}?`)) {
              return;
            }

            void rollbackToHistory(item);
          }}
        />
      </section>
    </div>
  );
}

function ConfigHistoryList({
  items,
  pendingRollbackId,
  onRollback,
}: {
  items: ConfigHistoryItem[];
  pendingRollbackId: number | null;
  onRollback: (item: ConfigHistoryItem) => void;
}) {
  if (items.length === 0) {
    return <EmptyState text="No config changes recorded yet." />;
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.id} className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">#{item.id}</p>
                {renderStatus(item.status)}
                <span className="status-pill status-waiting">{item.action}</span>
                {item.restartRequiredKeys.length > 0 ? <span className="status-pill status-failed">restart</span> : null}
              </div>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {item.reason || "update"} 路 {item.triggerSource || "web"} 路 {formatDateTime(item.createdAt)}
                {typeof item.restoredFromAuditId === "number" ? ` 路 restored from #${item.restoredFromAuditId}` : ""}
              </p>
              <p className="mt-3 text-sm text-[var(--muted)]">
                {item.changedKeys.length > 0 ? item.changedKeys.join(", ") : "No effective key changes"}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                disabled={pendingRollbackId === item.id}
                onClick={() => {
                  onRollback(item);
                }}
                className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)] disabled:cursor-wait disabled:opacity-60"
              >
                {pendingRollbackId === item.id ? "Rolling back..." : "Rollback"}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RunsPage() {
  const pageSize = 25;
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(0);
  const offset = page * pageSize;
  const statusQuery = statusFilter === "all" ? "" : `&status=${encodeURIComponent(statusFilter)}`;

  const runsQuery = useQuery({
    queryKey: ["dashboard", "runs", statusFilter, offset],
    queryFn: async () => fetchJson<PagedResponse<DashboardRunItem>>(`/api/dashboard/runs?limit=${pageSize}&offset=${offset}${statusQuery}`),
  });

  const items = runsQuery.data?.items ?? [];
  const total = runsQuery.data?.total ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = offset + items.length;

  return (
    <div className="flex flex-col gap-6">
      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">history</p>
            <h2 className="mt-1 text-3xl font-semibold tracking-tight">Run History</h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--muted)]">
              Browse the complete pipeline run log instead of only the recent dashboard slice.
            </p>
          </div>
          <label className="flex min-w-[220px] flex-col gap-2 text-sm text-[var(--muted)]">
            Status filter
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(0);
              }}
              className="rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
            >
              <option value="all">All statuses</option>
              <option value="running">Running</option>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
        </div>
      </section>

      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">runs</p>
            <h3 className="text-xl font-semibold">All Pipeline Runs</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">
            {pageStart}-{pageEnd} / {total}
          </span>
        </div>

        <RunTable items={items} emptyText="No runs match the current filter." />

        <PaginationControls
          className="mt-4"
          canGoPrevious={page > 0}
          canGoNext={Boolean(runsQuery.data?.hasMore)}
          onPrevious={() => {
            setPage((current) => Math.max(0, current - 1));
          }}
          onNext={() => {
            if (runsQuery.data?.hasMore) {
              setPage((current) => current + 1);
            }
          }}
        />
      </section>
    </div>
  );
}

function PipelineDetailPage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [runPage, setRunPage] = useState(0);
  const [eventPage, setEventPage] = useState(0);
  const bvid = String(params.bvid ?? "").trim();
  const runPageSize = 10;
  const eventPageSize = 25;

  useEffect(() => {
    setRunPage(0);
    setEventPage(0);
  }, [bvid]);

  const detailQuery = useQuery({
    queryKey: ["pipeline", bvid],
    enabled: Boolean(bvid),
    queryFn: async () => fetchJson<{ ok: true; detail: PipelineDetailResponse }>(`/api/dashboard/pipeline/${encodeURIComponent(bvid)}`),
  });
  const runsQuery = useQuery({
    queryKey: ["pipeline", bvid, "runs", runPage],
    enabled: Boolean(bvid),
    queryFn: async () => fetchJson<PagedResponse<DashboardRunItem>>(
      `/api/dashboard/pipeline/${encodeURIComponent(bvid)}/runs?limit=${runPageSize}&offset=${runPage * runPageSize}`,
    ),
  });
  const eventsQuery = useQuery({
    queryKey: ["pipeline", bvid, "events", eventPage],
    enabled: Boolean(bvid),
    queryFn: async () => fetchJson<PagedResponse<PipelineEventItem>>(
      `/api/dashboard/pipeline/${encodeURIComponent(bvid)}/events?limit=${eventPageSize}&offset=${eventPage * eventPageSize}`,
    ),
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
  const runItems = runsQuery.data?.items ?? detail?.recentRuns ?? [];
  const eventItems = eventsQuery.data?.items ?? detail?.recentEvents ?? [];

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
            label="Recover zombie"
            busy={pendingAction === "recover-zombie"}
            onClick={() => {
              if (!window.confirm("Recover this pipeline if it is stale without a live lock? This will mark the stale run failed and queue a retry.")) {
                return;
              }

              void runAction("recover-zombie", `/api/actions/pipeline/${encodeURIComponent(bvid)}/recover-zombie`, {
                confirm: true,
                retry: true,
                staleMs: 15 * 60 * 1000,
                reason: "detail-zombie-recovery",
              });
            }}
          />
          {detail?.latestRun?.runStatus === "running" ? (
            <ActionButton
              label="Cancel run"
              busy={pendingAction === "cancel"}
              onClick={() => {
                if (!window.confirm("Cancel the running pipeline now?")) {
                  return;
                }

                void runAction("cancel", `/api/actions/pipeline/${encodeURIComponent(bvid)}/cancel`, {
                  reason: "manual-cancel",
                });
              }}
            />
          ) : null}
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
              <h3 className="text-xl font-semibold">Run History</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{runsQuery.data?.total ?? detail?.recentRuns.length ?? 0} runs</span>
          </div>
          {runItems.length === 0 ? (
            <EmptyState text="No runs recorded for this pipeline yet." />
          ) : (
            <div className="flex flex-col gap-3">
              {runItems.map((run) => (
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
          )}
          <PaginationControls
            className="mt-4"
            canGoPrevious={runPage > 0}
            canGoNext={Boolean(runsQuery.data?.hasMore)}
            onPrevious={() => {
              setRunPage((current) => Math.max(0, current - 1));
            }}
            onNext={() => {
              if (runsQuery.data?.hasMore) {
                setRunPage((current) => current + 1);
              }
            }}
          />
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">timeline</p>
              <h3 className="text-xl font-semibold">Event Timeline</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{eventsQuery.data?.total ?? detail?.recentEvents.length ?? 0} events</span>
          </div>
          {eventItems.length === 0 ? (
            <EmptyState text="No events recorded for this pipeline yet." />
          ) : (
            <div className="timeline flex flex-col gap-4">
              {eventItems.map((event) => (
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
          )}
          <PaginationControls
            className="mt-4"
            canGoPrevious={eventPage > 0}
            canGoNext={Boolean(eventsQuery.data?.hasMore)}
            onPrevious={() => {
              setEventPage((current) => Math.max(0, current - 1));
            }}
            onNext={() => {
              if (eventsQuery.data?.hasMore) {
                setEventPage((current) => current + 1);
              }
            }}
          />
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
      <KeyValueCard label="Last retry sweep" value={formatDateTime(status.taskTimes["retry-failures"] ?? null)} />
      <KeyValueCard label="Concurrency" value={status.summaryConcurrency ? String(status.summaryConcurrency) : "-"} />
      <KeyValueCard label="Last error" value={status.lastError || "-"} />
    </div>
  );
}

function HealthWatchCard({
  snapshot,
  items,
}: {
  snapshot: DashboardHealthSnapshot | null;
  items: AttentionItem[];
}) {
  if (!snapshot) {
    return <EmptyState text="Operational health snapshot is not available yet." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <KeyValueCard label="Critical" value={String(snapshot.criticalCount)} />
      <KeyValueCard label="Warnings" value={String(snapshot.warningCount)} />
      <KeyValueCard label="Stalled runs" value={String(snapshot.staleRunningCount)} />
      <KeyValueCard label="Heartbeat age" value={formatDuration(snapshot.schedulerHeartbeatAgeMs)} />
      {items.length === 0 ? (
        <EmptyState text="No attention items right now." />
      ) : (
        items.map((item) => (
          <div key={`${item.kind}:${item.runId || item.updatedAt || item.title}`} className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold">{item.title}</p>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  {item.currentStage || item.status || item.kind}
                  {item.bvid ? ` · ${item.bvid}` : ""}
                </p>
              </div>
              {renderSeverity(item.severity)}
            </div>
            <p className="mt-3 text-sm text-[var(--muted)]">{item.message}</p>
            <p className="mt-2 text-xs uppercase tracking-[0.16em] text-[var(--muted)]">{formatDateTime(item.updatedAt)}</p>
          </div>
        ))
      )}
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

function FailureGroupList({ items }: { items: FailureGroupItem[] }) {
  if (items.length === 0) {
    return <EmptyState text="No repeated failures detected in the recent window." />;
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.key} className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-semibold">{item.failedStep || item.failureCategory}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">{item.failureCategory} · {item.count} runs</p>
            </div>
            <div className="flex items-center gap-2">
              {renderResolution(item.resolution)}
              <span className="rounded-full bg-[var(--panel-soft)] px-3 py-1 text-xs font-semibold text-[var(--muted)]">
                x{item.count}
              </span>
            </div>
          </div>
          <p className="mt-3 text-sm text-[var(--muted)]">{item.latestMessage || item.resolutionReason}</p>
          <p className="mt-2 text-xs uppercase tracking-[0.16em] text-[var(--muted)]">{formatDateTime(item.latestUpdatedAt)}</p>
        </div>
      ))}
    </div>
  );
}

function RecoveryCandidateList({
  items,
  pendingAction,
  onRecover,
  onCancel,
}: {
  items: RecoveryCandidateItem[];
  pendingAction: string | null;
  onRecover: (item: RecoveryCandidateItem) => void;
  onCancel: (item: RecoveryCandidateItem) => void;
}) {
  if (items.length === 0) {
    return <EmptyState text="No stale or zombie pipeline candidates right now." />;
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.runId} className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">{item.videoTitle || item.bvid || item.runId}</p>
                {renderStatus(item.runStatus)}
                <span className="status-pill status-waiting">{item.recoveryState}</span>
              </div>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {item.bvid || "-"} 路 stale for {formatDuration(item.staleForMs)} 路 {item.currentStage || "-"}
              </p>
              <p className="mt-3 text-sm text-[var(--muted)]">{item.recoveryReason}</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {item.recommendedAction === "cancel" ? (
                <ActionButton
                  label="Cancel stale run"
                  busy={pendingAction === `cancel-${item.bvid}`}
                  onClick={() => {
                    onCancel(item);
                  }}
                />
              ) : (
                <ActionButton
                  label="Recover zombie"
                  busy={pendingAction === `recover-${item.bvid}`}
                  onClick={() => {
                    onRecover(item);
                  }}
                />
              )}
              <Link
                to={`/pipeline/${encodeURIComponent(item.bvid ?? "")}`}
                className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)]"
              >
                Open detail
              </Link>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function FailureQueueList({
  items,
  pendingAction,
  onRetry,
}: {
  items: FailureQueueItem[];
  pendingAction: string | null;
  onRetry: (item: FailureQueueItem) => void;
}) {
  if (items.length === 0) {
    return <EmptyState text="No failed pipelines in the recent window." />;
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.runId} className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">{item.videoTitle || item.bvid || "Unknown video"}</p>
                {renderStatus(item.runStatus)}
                {renderResolution(item.resolution)}
              </div>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {item.failedStep || item.currentStage || "failed"} · {item.failureCategory} · {formatDateTime(item.updatedAt)}
              </p>
              <p className="mt-3 text-sm text-[var(--muted)]">{item.lastErrorMessage || item.lastMessage || item.resolutionReason}</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {item.bvid ? (
                <Link
                  to={`/pipeline/${encodeURIComponent(item.bvid)}`}
                  className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)]"
                >
                  Inspect
                </Link>
              ) : null}
              {item.bvid && item.resolution === "retryable" ? (
                <button
                  type="button"
                  disabled={pendingAction === `retry-${item.bvid}`}
                  onClick={() => {
                    onRetry(item);
                  }}
                  className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)] disabled:cursor-wait disabled:opacity-60"
                >
                  {pendingAction === `retry-${item.bvid}` ? "Retrying..." : "Retry"}
                </button>
              ) : null}
            </div>
          </div>
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

function ManagedSettingsGroup({
  definitions,
  draft,
  onChange,
}: {
  definitions: ManagedSettingDefinition[];
  draft: ManagedSettings | null;
  onChange: Dispatch<SetStateAction<ManagedSettings | null>>;
}) {
  if (!draft) {
    return <EmptyState text="Loading managed settings..." />;
  }

  return (
    <div className="grid gap-4">
      {definitions.map((definition) => {
        const value = getManagedSettingValue(draft, definition.key);
        const control = definition.input === "textarea" ? (
          <textarea
            value={value === null || value === undefined ? "" : String(value)}
            onChange={(event) => {
              onChange((current) => updateManagedSettingValue(current, definition.key, event.target.value));
            }}
            rows={4}
            className="min-h-[112px] rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)]"
          />
        ) : definition.input === "select" ? (
          <select
            value={value === null || value === undefined ? "" : String(value)}
            onChange={(event) => {
              onChange((current) => updateManagedSettingValue(current, definition.key, event.target.value));
            }}
            className="rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)]"
          >
            {(definition.options ?? []).map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        ) : (
          <input
            type={definition.input === "number" ? "number" : "text"}
            value={value === null || value === undefined ? "" : String(value)}
            onChange={(event) => {
              onChange((current) => updateManagedSettingValue(current, definition.key, event.target.value));
            }}
            className="rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)]"
          />
        );

        return (
          <div key={definition.key} className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold">{definition.label}</p>
                  {definition.requiresRestart ? <span className="status-pill status-failed">restart</span> : <span className="status-pill status-succeeded">hot</span>}
                </div>
                <p className="mt-1 text-sm text-[var(--muted)]">{definition.description}</p>
              </div>
            </div>
            <div className="mt-4">{control}</div>
            <p className="mt-3 text-xs leading-5 text-[var(--muted)]">Effective scope: {definition.effectiveScope}</p>
          </div>
        );
      })}
    </div>
  );
}

function SchedulerPlanCard({ schedule }: { schedule: SchedulerPlan | null }) {
  if (!schedule) {
    return <EmptyState text="No schedule information available." />;
  }

  return (
    <div className="flex flex-col gap-3">
      {schedule.tasks.map((task) => (
        <div key={task.key} className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold">{task.label}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">{task.description}</p>
            </div>
            <span className="rounded-full border border-[var(--line)] bg-white/90 px-3 py-1 text-xs font-semibold tracking-[0.08em] text-[var(--muted)]">
              {task.cron}
            </span>
          </div>
        </div>
      ))}
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

function PaginationControls({
  className = "",
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
}: {
  className?: string;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className={`flex items-center justify-end gap-3 ${className}`.trim()}>
      <button
        type="button"
        disabled={!canGoPrevious}
        onClick={onPrevious}
        className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        Previous
      </button>
      <button
        type="button"
        disabled={!canGoNext}
        onClick={onNext}
        className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        Next
      </button>
    </div>
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
        : normalized === "cancelled"
          ? "status-skipped"
        : normalized === "waiting"
          ? "status-waiting"
          : "status-skipped";

  return <span className={`status-pill ${className}`}>{normalized}</span>;
}

function renderResolution(resolution: FailureQueueItem["resolution"]) {
  const normalized = String(resolution || "inspect").toLowerCase() as FailureQueueItem["resolution"];
  const className = normalized === "retryable"
    ? "status-running"
    : normalized === "manual"
      ? "status-failed"
      : "status-waiting";

  return <span className={`status-pill ${className}`}>{normalized}</span>;
}

function renderSeverity(severity: AttentionItem["severity"]) {
  const normalized = String(severity || "warning").toLowerCase();
  const className = normalized === "critical" ? "status-failed" : "status-waiting";
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

async function putJson<T>(targetPath: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(buildApiUrl(targetPath), {
    method: "PUT",
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
        return Array.isArray(query.queryKey) && (query.queryKey[0] === "dashboard" || query.queryKey[0] === "scheduler" || query.queryKey[0] === "audits" || query.queryKey[0] === "settings");
      },
    }),
    bvid
      ? queryClient.invalidateQueries({
        queryKey: ["pipeline", bvid],
      })
      : Promise.resolve(),
  ]);
}

function getManagedSettingValue(settings: ManagedSettings, key: string): string | number | null {
  switch (key) {
    case "scheduler.authFile":
      return settings.scheduler.authFile;
    case "scheduler.cookieFile":
      return settings.scheduler.cookieFile;
    case "scheduler.timezone":
      return settings.scheduler.timezone;
    case "scheduler.summaryUsers":
      return settings.scheduler.summaryUsers;
    case "scheduler.summarySinceHours":
      return settings.scheduler.summarySinceHours;
    case "scheduler.summaryConcurrency":
      return settings.scheduler.summaryConcurrency;
    case "scheduler.retryFailuresLimit":
      return settings.scheduler.retryFailuresLimit;
    case "scheduler.retryFailuresSinceHours":
      return settings.scheduler.retryFailuresSinceHours;
    case "scheduler.retryFailuresMaxRecent":
      return settings.scheduler.retryFailuresMaxRecent;
    case "scheduler.retryFailuresWindowHours":
      return settings.scheduler.retryFailuresWindowHours;
    case "scheduler.zombieRecoveryEnabled":
      return String(settings.scheduler.zombieRecoveryEnabled);
    case "scheduler.zombieRecoveryStaleMs":
      return settings.scheduler.zombieRecoveryStaleMs;
    case "scheduler.zombieRecoveryLimit":
      return settings.scheduler.zombieRecoveryLimit;
    case "scheduler.zombieRecoveryMaxRecent":
      return settings.scheduler.zombieRecoveryMaxRecent;
    case "scheduler.zombieRecoveryWindowHours":
      return settings.scheduler.zombieRecoveryWindowHours;
    case "scheduler.zombieRecoveryRetry":
      return String(settings.scheduler.zombieRecoveryRetry);
    case "scheduler.zombieRecoveryStates":
      return settings.scheduler.zombieRecoveryStates;
    case "scheduler.refreshDays":
      return settings.scheduler.refreshDays;
    case "scheduler.cleanupDays":
      return settings.scheduler.cleanupDays;
    case "scheduler.gapCheckSinceHours":
      return settings.scheduler.gapCheckSinceHours;
    case "scheduler.gapThresholdSeconds":
      return settings.scheduler.gapThresholdSeconds;
    case "scheduler.summaryCron":
      return settings.scheduler.summaryCron;
    case "scheduler.publishCron":
      return settings.scheduler.publishCron;
    case "scheduler.gapCheckCron":
      return settings.scheduler.gapCheckCron;
    case "scheduler.retryFailuresCron":
      return settings.scheduler.retryFailuresCron;
    case "scheduler.zombieRecoveryCron":
      return settings.scheduler.zombieRecoveryCron;
    case "scheduler.refreshCron":
      return settings.scheduler.refreshCron;
    case "scheduler.cleanupCron":
      return settings.scheduler.cleanupCron;
    case "summary.model":
      return settings.summary.model;
    case "summary.apiBaseUrl":
      return settings.summary.apiBaseUrl;
    case "summary.apiFormat":
      return settings.summary.apiFormat;
    case "summary.promptConfigPath":
      return settings.summary.promptConfigPath;
    case "summary.promptConfigContent":
      return settings.summary.promptConfigContent;
    case "publish.appendCooldownMinMs":
      return settings.publish.appendCooldownMinMs;
    case "publish.appendCooldownMaxMs":
      return settings.publish.appendCooldownMaxMs;
    case "publish.rebuildCooldownMinMs":
      return settings.publish.rebuildCooldownMinMs;
    case "publish.rebuildCooldownMaxMs":
      return settings.publish.rebuildCooldownMaxMs;
    case "publish.maxConcurrent":
      return settings.publish.maxConcurrent;
    case "publish.healthcheckSinceHours":
      return settings.publish.healthcheckSinceHours;
    case "publish.includeRecentPublishedHealthcheck":
      return String(settings.publish.includeRecentPublishedHealthcheck);
    case "publish.stopOnFirstFailure":
      return String(settings.publish.stopOnFirstFailure);
    case "publish.rebuildPriority":
      return settings.publish.rebuildPriority;
    case "publish.cooldownOnlyWhenCommentsCreated":
      return String(settings.publish.cooldownOnlyWhenCommentsCreated);
    default:
      return null;
  }
}

function updateManagedSettingValue(
  current: ManagedSettings | null,
  key: string,
  rawValue: string,
): ManagedSettings | null {
  if (!current) {
    return current;
  }

  const next: ManagedSettings = {
    scheduler: { ...current.scheduler },
    summary: { ...current.summary },
    publish: { ...current.publish },
  };
  const nullableValue = rawValue.trim() ? rawValue : null;

  switch (key) {
    case "scheduler.authFile":
      next.scheduler.authFile = rawValue;
      return next;
    case "scheduler.cookieFile":
      next.scheduler.cookieFile = nullableValue;
      return next;
    case "scheduler.timezone":
      next.scheduler.timezone = nullableValue;
      return next;
    case "scheduler.summaryUsers":
      next.scheduler.summaryUsers = rawValue;
      return next;
    case "scheduler.summarySinceHours":
      next.scheduler.summarySinceHours = normalizeNumericInput(rawValue, current.scheduler.summarySinceHours);
      return next;
    case "scheduler.summaryConcurrency":
      next.scheduler.summaryConcurrency = normalizeNumericInput(rawValue, current.scheduler.summaryConcurrency);
      return next;
    case "scheduler.retryFailuresLimit":
      next.scheduler.retryFailuresLimit = normalizeNumericInput(rawValue, current.scheduler.retryFailuresLimit);
      return next;
    case "scheduler.retryFailuresSinceHours":
      next.scheduler.retryFailuresSinceHours = normalizeNumericInput(rawValue, current.scheduler.retryFailuresSinceHours);
      return next;
    case "scheduler.retryFailuresMaxRecent":
      next.scheduler.retryFailuresMaxRecent = normalizeNumericInput(rawValue, current.scheduler.retryFailuresMaxRecent);
      return next;
    case "scheduler.retryFailuresWindowHours":
      next.scheduler.retryFailuresWindowHours = normalizeNumericInput(rawValue, current.scheduler.retryFailuresWindowHours);
      return next;
    case "scheduler.zombieRecoveryEnabled":
      next.scheduler.zombieRecoveryEnabled = normalizeBooleanInput(rawValue, current.scheduler.zombieRecoveryEnabled);
      return next;
    case "scheduler.zombieRecoveryStaleMs":
      next.scheduler.zombieRecoveryStaleMs = normalizeNumericInput(rawValue, current.scheduler.zombieRecoveryStaleMs);
      return next;
    case "scheduler.zombieRecoveryLimit":
      next.scheduler.zombieRecoveryLimit = normalizeNumericInput(rawValue, current.scheduler.zombieRecoveryLimit);
      return next;
    case "scheduler.zombieRecoveryMaxRecent":
      next.scheduler.zombieRecoveryMaxRecent = normalizeNumericInput(rawValue, current.scheduler.zombieRecoveryMaxRecent);
      return next;
    case "scheduler.zombieRecoveryWindowHours":
      next.scheduler.zombieRecoveryWindowHours = normalizeNumericInput(rawValue, current.scheduler.zombieRecoveryWindowHours);
      return next;
    case "scheduler.zombieRecoveryRetry":
      next.scheduler.zombieRecoveryRetry = normalizeBooleanInput(rawValue, current.scheduler.zombieRecoveryRetry);
      return next;
    case "scheduler.zombieRecoveryStates":
      next.scheduler.zombieRecoveryStates = rawValue;
      return next;
    case "scheduler.refreshDays":
      next.scheduler.refreshDays = normalizeNumericInput(rawValue, current.scheduler.refreshDays);
      return next;
    case "scheduler.cleanupDays":
      next.scheduler.cleanupDays = normalizeNumericInput(rawValue, current.scheduler.cleanupDays);
      return next;
    case "scheduler.gapCheckSinceHours":
      next.scheduler.gapCheckSinceHours = normalizeNumericInput(rawValue, current.scheduler.gapCheckSinceHours);
      return next;
    case "scheduler.gapThresholdSeconds":
      next.scheduler.gapThresholdSeconds = normalizeNumericInput(rawValue, current.scheduler.gapThresholdSeconds);
      return next;
    case "scheduler.summaryCron":
      next.scheduler.summaryCron = rawValue;
      return next;
    case "scheduler.publishCron":
      next.scheduler.publishCron = rawValue;
      return next;
    case "scheduler.gapCheckCron":
      next.scheduler.gapCheckCron = rawValue;
      return next;
    case "scheduler.retryFailuresCron":
      next.scheduler.retryFailuresCron = rawValue;
      return next;
    case "scheduler.zombieRecoveryCron":
      next.scheduler.zombieRecoveryCron = rawValue;
      return next;
    case "scheduler.refreshCron":
      next.scheduler.refreshCron = rawValue;
      return next;
    case "scheduler.cleanupCron":
      next.scheduler.cleanupCron = rawValue;
      return next;
    case "summary.model":
      next.summary.model = rawValue;
      return next;
    case "summary.apiBaseUrl":
      next.summary.apiBaseUrl = rawValue;
      return next;
    case "summary.apiFormat":
      next.summary.apiFormat = rawValue as ManagedSettings["summary"]["apiFormat"];
      return next;
    case "summary.promptConfigPath":
      next.summary.promptConfigPath = nullableValue;
      return next;
    case "summary.promptConfigContent":
      next.summary.promptConfigContent = nullableValue;
      return next;
    case "publish.appendCooldownMinMs":
      next.publish.appendCooldownMinMs = normalizeNumericInput(rawValue, current.publish.appendCooldownMinMs);
      return next;
    case "publish.appendCooldownMaxMs":
      next.publish.appendCooldownMaxMs = normalizeNumericInput(rawValue, current.publish.appendCooldownMaxMs);
      return next;
    case "publish.rebuildCooldownMinMs":
      next.publish.rebuildCooldownMinMs = normalizeNumericInput(rawValue, current.publish.rebuildCooldownMinMs);
      return next;
    case "publish.rebuildCooldownMaxMs":
      next.publish.rebuildCooldownMaxMs = normalizeNumericInput(rawValue, current.publish.rebuildCooldownMaxMs);
      return next;
    case "publish.maxConcurrent":
      next.publish.maxConcurrent = normalizeNumericInput(rawValue, current.publish.maxConcurrent);
      return next;
    case "publish.healthcheckSinceHours":
      next.publish.healthcheckSinceHours = normalizeNumericInput(rawValue, current.publish.healthcheckSinceHours);
      return next;
    case "publish.includeRecentPublishedHealthcheck":
      next.publish.includeRecentPublishedHealthcheck = normalizeBooleanInput(rawValue, current.publish.includeRecentPublishedHealthcheck);
      return next;
    case "publish.stopOnFirstFailure":
      next.publish.stopOnFirstFailure = normalizeBooleanInput(rawValue, current.publish.stopOnFirstFailure);
      return next;
    case "publish.rebuildPriority":
      next.publish.rebuildPriority = rawValue === "rebuild-first" ? "rebuild-first" : "append-first";
      return next;
    case "publish.cooldownOnlyWhenCommentsCreated":
      next.publish.cooldownOnlyWhenCommentsCreated = normalizeBooleanInput(rawValue, current.publish.cooldownOnlyWhenCommentsCreated);
      return next;
    default:
      return current;
  }
}

function normalizeNumericInput(rawValue: string, fallback: number): number {
  const normalized = Number(rawValue);
  return Number.isFinite(normalized) ? normalized : fallback;
}

function normalizeBooleanInput(rawValue: string, fallback: boolean): boolean {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return fallback;
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
    triggered?: unknown;
    skipped?: unknown;
    failed?: unknown;
    signalSent?: unknown;
    ownerPid?: unknown;
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

  if (typeof payload.triggered === "number" || typeof payload.skipped === "number" || typeof payload.failed === "number") {
    return `triggered=${String(payload.triggered ?? "-")}, skipped=${String(payload.skipped ?? "-")}, failed=${String(payload.failed ?? "-")}`;
  }

  if (payload.signalSent === true) {
    return `signal sent${typeof payload.ownerPid === "number" ? ` to pid ${payload.ownerPid}` : ""}`;
  }

  if (Array.isArray(payload.generatedPages)) {
    return `generated pages: ${payload.generatedPages.length}`;
  }

  return "";
}

function isSchedulerRestartPending(
  scheduler: SchedulerStatus | null,
  audit: ConfigHistoryItem | undefined,
): boolean {
  if (!audit || audit.restartRequiredKeys.length === 0) {
    return false;
  }

  const auditTimestamp = new Date(audit.createdAt).getTime();
  if (!Number.isFinite(auditTimestamp)) {
    return true;
  }

  const startedAtTimestamp = scheduler?.startedAt ? new Date(scheduler.startedAt).getTime() : Number.NaN;
  if (!Number.isFinite(startedAtTimestamp)) {
    return true;
  }

  return startedAtTimestamp < auditTimestamp;
}
