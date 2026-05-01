import { createContext, startTransition, useContext, useDeferredValue, useEffect, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Route, Routes, useLocation, useParams } from "react-router-dom";
import {
  DEFAULT_LOCALE,
  getInitialLocale,
  localizeManagedSettingDefinition,
  localizeSchedulerTask,
  persistLocale,
  translate,
  translateOptional,
  type Locale,
} from "./i18n";

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

type BiliLoginSession = {
  id: string;
  status: "pending" | "scanned" | "completed" | "failed" | "cancelled";
  authFile: string;
  cookieFile: string | null;
  loginUrl: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  mid: number | null;
};

const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL ?? "").trim();

type I18nContextValue = {
  locale: Locale;
  setLocale: Dispatch<SetStateAction<Locale>>;
  t: (key: string, vars?: Record<string, number | string>) => string;
  tOptional: (key: string, vars?: Record<string, number | string>) => string | null;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export default function App() {
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale());

  useEffect(() => {
    persistLocale(locale);
  }, [locale]);

  const value: I18nContextValue = {
    locale,
    setLocale,
    t: (key, vars) => translate(locale, key, vars),
    tOptional: (key, vars) => translateOptional(locale, key, vars),
  };

  return (
    <I18nContext.Provider value={value}>
      <div className="min-h-screen px-3 py-4 sm:px-5 lg:px-8">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-4">
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
    </I18nContext.Provider>
  );
}

function Header() {
  const { locale, setLocale, t } = useI18n();
  const navItems = [
    { to: "/", label: t("nav.dashboard") },
    { to: "/runs", label: t("nav.runs") },
    { to: "/failures", label: t("nav.failures") },
    { to: "/health", label: t("nav.health") },
    { to: "/settings", label: t("nav.settings") },
  ];

  return (
    <header className="glass-panel overflow-hidden rounded-[1.75rem]">
      <div className="flex flex-col gap-4 bg-[linear-gradient(135deg,rgba(36,99,235,0.12),rgba(255,255,255,0.55),rgba(255,255,255,0))] px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">{t("header.brand")}</p>
            <h1 className="mt-2 text-[2rem] font-semibold tracking-[-0.04em] sm:text-[2.4rem]">{t("header.title")}</h1>
          </div>
          <div className="flex flex-col items-start gap-3 lg:items-end">
            <div className="inline-flex rounded-full border border-[var(--line)] bg-white/70 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
              {(["zh-CN", "en-US"] as Locale[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    setLocale(option);
                  }}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                    locale === option
                      ? "bg-[var(--ink)] text-white shadow-[0_10px_20px_rgba(15,23,42,0.18)]"
                      : "text-[var(--muted)] hover:text-[var(--ink)]"
                  }`}
                >
                  {t(`locale.${option}`)}
                </button>
              ))}
            </div>
            <nav className="flex flex-wrap gap-2">
              {navItems.map((item) => <HeaderLink key={item.to} to={item.to} label={item.label} />)}
            </nav>
          </div>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-[var(--muted)]">
          {t("header.description")}
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
      className="rounded-full border border-[var(--line)] bg-white/72 px-3.5 py-1.5 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)] hover:bg-white/88"
    >
      {label}
    </Link>
  );
}

function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("I18nContext is missing");
  }

  return context;
}

function useUiText() {
  const { locale, t, tOptional } = useI18n();
  return {
    locale,
    t,
    tOptional,
    formatDateTime(value: string | null | undefined) {
      return formatDateTime(value, locale);
    },
    formatDuration(value: number | null | undefined) {
      return formatDuration(value, locale);
    },
  };
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
  const { t, formatDateTime } = useUiText();
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
      setActionMessage(t("dashboard.actionFailed", { message: response.errorMessage || t("common.unknown") }));
      setPendingAction(null);
      await refreshQueries(queryClient);
      return;
    }

    setActionMessage(t("dashboard.actionQueued", { auditId: response.auditId }));
    setPendingAction(null);
    await refreshQueries(queryClient);
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="glass-panel rounded-[1.6rem]">
        <StatStrip
          items={[
            { title: t("dashboard.metric.active"), value: summary?.activeCount ?? 0, tone: "accent" },
            { title: t("dashboard.metric.succeeded24h"), value: summary?.succeededCount24h ?? 0, tone: "success" },
            { title: t("dashboard.metric.failed24h"), value: summary?.failedCount24h ?? 0, tone: "danger" },
            { title: t("dashboard.metric.attention"), value: healthSnapshot?.attentionCount ?? 0, tone: (healthSnapshot?.criticalCount ?? 0) > 0 ? "danger" : "neutral" },
            { title: t("dashboard.metric.latestUpdate"), value: formatDateTime(summary?.latestUpdatedAt), tone: "neutral" },
          ]}
        />
        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("dashboard.eyebrow.controls")}</p>
            <h2 className="mt-1 text-[1.65rem] font-semibold tracking-[-0.03em]">{t("dashboard.title.actions")}</h2>
          </div>
          <label className="flex w-full max-w-sm flex-col gap-2 text-sm text-[var(--muted)]">
            {t("common.byBvidOrTitle")}
            <input
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
              }}
              className="rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
              placeholder={t("common.filterPlaceholder")}
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <ActionButton
            label={t("dashboard.button.summarySweep")}
            busy={pendingAction === "summary-sweep"}
            onClick={() => {
              void runAction("summary-sweep", "/api/actions/summary-sweep", {});
            }}
          />
          <ActionButton
            label={t("dashboard.button.gapCheck")}
            busy={pendingAction === "gap-check"}
            onClick={() => {
              void runAction("gap-check", "/api/actions/gap-check", {});
            }}
          />
          <ActionButton
            label={t("dashboard.button.publishSweep")}
            busy={pendingAction === "publish-sweep"}
            onClick={() => {
              if (!window.confirm(t("dashboard.confirm.publishSweep"))) {
                return;
              }

              void runAction("publish-sweep", "/api/actions/publish-sweep", {
                confirm: true,
              });
            }}
          />
          <ActionButton
            label={t("dashboard.button.retryFailures")}
            busy={pendingAction === "retry-failures"}
            onClick={() => {
              if (!window.confirm(t("dashboard.confirm.retryFailures"))) {
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

      <section className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("dashboard.eyebrow.active")}</p>
              <h3 className="text-xl font-semibold">{t("dashboard.title.activePipelines")}</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{t("common.rows", { count: activeItems.length })}</span>
          </div>
          <RunTable items={activeItems} emptyText={t("dashboard.empty.active")} />
        </div>

        <div className="glass-panel rounded-[1.6rem]">
          <div className="space-y-5">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("dashboard.eyebrow.scheduler")}</p>
              <h3 className="text-xl font-semibold">{t("dashboard.title.daemonStatus")}</h3>
              <div className="mt-3">
                <SchedulerStatusCard status={scheduler ?? null} />
              </div>
            </div>

            <div className="border-t border-[var(--line)] pt-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("dashboard.eyebrow.attention")}</p>
                  <h3 className="text-xl font-semibold">{t("dashboard.title.healthWatch")}</h3>
                </div>
                <span className="text-sm text-[var(--muted)]">{t("common.items", { count: attentionItems.length })}</span>
              </div>
              <HealthWatchCard snapshot={healthSnapshot ?? null} items={attentionItems.slice(0, 4)} />
            </div>

            <div className="border-t border-[var(--line)] pt-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("dashboard.eyebrow.hotspots")}</p>
                  <h3 className="text-xl font-semibold">{t("dashboard.title.failureGroups")}</h3>
                </div>
                <span className="text-sm text-[var(--muted)]">{t("common.groups", { count: failureGroupItems.length })}</span>
              </div>
              <FailureGroupList items={failureGroupItems.slice(0, 4)} />
            </div>
          </div>
        </div>
      </section>

      <section className="glass-panel rounded-[1.6rem]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("dashboard.eyebrow.queue")}</p>
            <h3 className="text-xl font-semibold">{t("dashboard.title.failureQueue")}</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">{t("common.items", { count: failureQueueItems.length })}</span>
        </div>
        <FailureQueueList
          items={failureQueueItems.slice(0, 8)}
          pendingAction={pendingAction}
          onRetry={(item) => {
            if (!item.bvid) {
              return;
            }

            void runAction(`retry-${item.bvid}`, `/api/actions/pipeline/${encodeURIComponent(item.bvid)}/retry`, {});
          }}
        />
      </section>
    </div>
  );
}

function FailuresPage() {
  const { t } = useUiText();
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
      setActionMessage(t("failures.actionFailed", { message: response.errorMessage || t("common.unknown") }));
      setPendingAction(null);
      await refreshQueries(queryClient);
      return;
    }

    setActionMessage(t("failures.actionAccepted", { auditId: response.auditId }));
    setPendingAction(null);
    await refreshQueries(queryClient);
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="glass-panel rounded-[1.6rem]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("failures.eyebrow.phase")}</p>
            <h2 className="mt-1 text-[1.65rem] font-semibold tracking-[-0.03em]">{t("failures.title.queue")}</h2>
          </div>
          <label className="flex w-full max-w-sm flex-col gap-2 text-sm text-[var(--muted)]">
            {t("common.byBvidOrTitle")}
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
              placeholder={t("common.filterPlaceholder")}
            />
          </label>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <ActionButton
            label={t("failures.button.retryFailures")}
            busy={pendingAction === "retry-failures"}
            onClick={() => {
              if (!window.confirm(t("failures.confirm.retryFailures"))) {
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

      <section className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("failures.eyebrow.clusters")}</p>
              <h3 className="text-xl font-semibold">{t("dashboard.title.failureGroups")}</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{t("common.groups", { count: failureGroupItems.length })}</span>
          </div>
          <FailureGroupList items={failureGroupItems} />
        </div>

        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("failures.eyebrow.items")}</p>
              <h3 className="text-xl font-semibold">{t("failures.title.queue")}</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{t("common.items", { count: failureQueueItems.length })}</span>
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

      <section className="glass-panel rounded-[1.6rem]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("dashboard.eyebrow.audits")}</p>
            <h3 className="text-xl font-semibold">{t("failures.title.recoveryActions")}</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">{t("common.rows", { count: auditItems.length })}</span>
        </div>
        <AuditList items={auditItems} emptyText={t("failures.empty.recoveryActions")} />
      </section>
    </div>
  );
}

function HealthPage() {
  const { t } = useUiText();
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
      setActionMessage(t("failures.actionFailed", { message: response.errorMessage || t("common.unknown") }));
      setPendingAction(null);
      await refreshQueries(queryClient);
      return;
    }

    setActionMessage(t("failures.actionAccepted", { auditId: response.auditId }));
    setPendingAction(null);
    await refreshQueries(queryClient);
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard title={t("health.metric.attention")} value={snapshot?.attentionCount ?? 0} tone={(snapshot?.criticalCount ?? 0) > 0 ? "danger" : "neutral"} />
        <MetricCard title={t("health.metric.critical")} value={snapshot?.criticalCount ?? 0} tone="danger" />
        <MetricCard title={t("health.metric.warnings")} value={snapshot?.warningCount ?? 0} tone="neutral" />
        <MetricCard title={t("health.metric.stalled")} value={snapshot?.staleRunningCount ?? 0} tone="accent" />
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("health.eyebrow.scheduler")}</p>
            <h2 className="text-[1.65rem] font-semibold tracking-[-0.03em]">{t("health.title.daemonHealth")}</h2>
          </div>
          <SchedulerStatusCard status={scheduler} />
        </div>

        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("health.eyebrow.attention")}</p>
            <h2 className="text-[1.65rem] font-semibold tracking-[-0.03em]">{t("health.title.attentionQueue")}</h2>
          </div>
          <HealthWatchCard snapshot={snapshot} items={attentionItems} />
        </div>
      </section>

      <section className="glass-panel rounded-[1.6rem]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("health.eyebrow.recovery")}</p>
            <h3 className="text-xl font-semibold">{t("health.title.recoveryCandidates")}</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">{t("common.rows", { count: recoveryItems.length })}</span>
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

            if (!window.confirm(t("health.confirm.recover", { bvid: item.bvid }))) {
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

            if (!window.confirm(t("health.confirm.cancel", { bvid: item.bvid }))) {
              return;
            }

            void runAction(`cancel-${item.bvid}`, `/api/actions/pipeline/${encodeURIComponent(item.bvid)}/cancel`, {
              reason: "health-page-stale-cancel",
            });
          }}
        />
      </section>

      <section className="glass-panel rounded-[1.6rem]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("health.eyebrow.running")}</p>
            <h3 className="text-xl font-semibold">{t("dashboard.title.activePipelines")}</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">{t("common.rows", { count: activeItems.length })}</span>
        </div>
        <RunTable items={activeItems} emptyText={t("dashboard.empty.active")} />
      </section>
    </div>
  );
}

function SettingsPage() {
  const { locale, t, formatDateTime } = useUiText();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ManagedSettings | null>(null);
  const [pendingSave, setPendingSave] = useState(false);
  const [pendingRollbackId, setPendingRollbackId] = useState<number | null>(null);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [pendingLoginStart, setPendingLoginStart] = useState(false);
  const [pendingLoginCancel, setPendingLoginCancel] = useState(false);
  const [loginSessionId, setLoginSessionId] = useState<string | null>(null);
  const [loginAuthFile, setLoginAuthFile] = useState("");
  const [loginCookieFile, setLoginCookieFile] = useState("");
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
  const loginSessionQuery = useQuery({
    queryKey: ["settings", "bili-login", loginSessionId],
    enabled: Boolean(loginSessionId),
    queryFn: async () => fetchJson<{ ok: true; session: BiliLoginSession }>(`/api/auth/bili-tv-login/${encodeURIComponent(String(loginSessionId))}`),
    refetchInterval(query) {
      const session = query.state.data?.session;
      return session && (session.status === "pending" || session.status === "scanned") ? 2000 : false;
    },
  });

  useEffect(() => {
    if (!settingsQuery.data?.settings) {
      return;
    }

    setDraft(settingsQuery.data.settings);
  }, [settingsQuery.data?.settings]);

  const definitions = (settingsQuery.data?.definitions ?? []).map((item) => localizeManagedSettingDefinition(locale, item));
  const schedule = settingsQuery.data?.schedule
    ? {
      ...settingsQuery.data.schedule,
      tasks: settingsQuery.data.schedule.tasks.map((item) => localizeSchedulerTask(locale, item)),
    }
    : null;
  const settings = settingsQuery.data?.settings ?? null;
  const configHistory = historyQuery.data?.items ?? [];
  const scheduler = schedulerQuery.data?.status ?? null;
  const loginSession = loginSessionQuery.data?.session ?? null;
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
      setMessage(t("settings.message.saveFailed", { message: response.errorMessage || t("common.unknown") }));
      return;
    }

    const changedKeys = Array.isArray(response.result?.changedKeys) ? response.result.changedKeys : [];
    const restartKeys = Array.isArray(response.result?.restartRequiredKeys) ? response.result.restartRequiredKeys : [];
    setPendingSave(false);
    setMessage(
      changedKeys.length > 0
        ? t("settings.message.saved", {
          count: changedKeys.length,
          auditId: response.auditId,
          restartNote: restartKeys.length > 0 ? t("settings.message.restartNote") : "",
        })
        : t("settings.message.noChanges", { auditId: response.auditId }),
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
      setMessage(t("settings.message.rollbackFailed", { message: response.errorMessage || t("common.unknown") }));
      return;
    }

    setPendingRollbackId(null);
    setMessage(t("settings.message.rolledBack", { sourceAuditId: item.id, newAuditId: response.auditId }));
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
      setMessage(t("settings.message.restartFailed", { message: response.errorMessage || t("common.unknown") }));
      return;
    }

    const ownerPid = typeof response.result?.ownerPid === "number" ? response.result.ownerPid : null;
    setMessage(t("settings.message.restartSent", {
      auditId: response.auditId,
      suffix: ownerPid ? t("settings.message.pidSuffix", { pid: ownerPid }) : "",
    }));
    await refreshQueries(queryClient);
  }

  async function startBiliLogin() {
    setPendingLoginStart(true);
    setMessage(null);
    const response = await postJson<{ ok: boolean; session?: BiliLoginSession; message?: string }>("/api/auth/bili-tv-login/start", {
      authFile: loginAuthFile.trim() || undefined,
      cookieFile: loginCookieFile.trim() || undefined,
    });
    setPendingLoginStart(false);

    if (!response.ok || !response.session) {
      setMessage(t("settings.message.loginStartFailed", { message: response.message || t("common.unknown") }));
      return;
    }

    setLoginSessionId(response.session.id);
    setMessage(t("settings.message.loginStarted"));
    await queryClient.invalidateQueries({
      queryKey: ["settings", "bili-login", response.session.id],
    });
  }

  async function cancelBiliLogin() {
    if (!loginSessionId) {
      return;
    }

    setPendingLoginCancel(true);
    setMessage(null);
    const response = await postJson<{ ok: boolean; session?: BiliLoginSession; message?: string }>(`/api/auth/bili-tv-login/${encodeURIComponent(loginSessionId)}/cancel`, {});
    setPendingLoginCancel(false);

    if (!response.ok) {
      setMessage(t("settings.message.loginCancelFailed", { message: response.message || t("common.unknown") }));
      return;
    }

    setMessage(t("settings.message.loginCancelled"));
    await queryClient.invalidateQueries({
      queryKey: ["settings", "bili-login", loginSessionId],
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="glass-panel rounded-[1.6rem]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("settings.eyebrow.phase")}</p>
            <h2 className="mt-1 text-[1.65rem] font-semibold tracking-[-0.03em]">{t("settings.title.runtime")}</h2>
            <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
              {t("settings.description")}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            <ActionButton
              label={t("settings.button.requestRestart")}
              busy={pendingRestart}
              onClick={() => {
                if (!window.confirm(t("settings.confirm.requestRestart"))) {
                  return;
                }

                void requestSchedulerRestart();
              }}
            />
            <ActionButton
              label={t("settings.button.resetDraft")}
              busy={pendingSave || pendingRestart}
              onClick={() => {
                if (settings) {
                  setDraft(settings);
                  setMessage(null);
                }
              }}
            />
            <ActionButton
              label={t("settings.button.save")}
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
          <MetricCard title={t("settings.metric.dirtyFields")} value={dirty ? t("common.yes") : t("common.no")} tone={dirty ? "accent" : "neutral"} />
          <MetricCard title={t("settings.metric.cronTimezone")} value={schedule?.timezone ?? t("common.system")} tone="neutral" />
          <MetricCard title={t("settings.metric.configAudits")} value={configHistory.length} tone="success" />
          <MetricCard title={t("settings.metric.restartRequired")} value={schedulerRestartPending ? t("common.yes") : t("common.no")} tone={schedulerRestartPending ? "danger" : "neutral"} />
        </div>
        <div className="mt-5 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">{t("settings.title.restartState")}</p>
              {schedulerRestartPending ? <span className="status-pill status-failed">{t("settings.restart.pending")}</span> : <span className="status-pill status-succeeded">{t("settings.restart.clear")}</span>}
            </div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              {schedulerRestartPending
                ? t("settings.restart.pendingDescription", { auditId: pendingRestartAudit?.id ?? "-" })
                : t("settings.restart.clearDescription")}
            </p>
          </div>
          <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">{t("settings.title.runningDaemon")}</p>
              {scheduler?.healthy ? <span className="status-pill status-succeeded">{t("common.healthy")}</span> : <span className="status-pill status-waiting">{scheduler?.status || t("common.unknown")}</span>}
            </div>
            <p className="mt-2 text-sm text-[var(--muted)]">
              {scheduler?.pid ? t("settings.daemon.pid", { pid: scheduler.pid }) : t("settings.daemon.noPid")}
              {scheduler?.mode ? ` · ${t("settings.daemon.mode", { mode: scheduler.mode })}` : ""}
              {scheduler?.startedAt ? ` · ${t("common.startedAt", { value: formatDateTime(scheduler.startedAt) })}` : ""}
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("settings.eyebrow.scheduler")}</p>
            <h3 className="text-xl font-semibold">{t("settings.title.sweepSettings")}</h3>
          </div>
          <ManagedSettingsGroup
            definitions={definitions.filter((item) => item.group === "scheduler")}
            draft={draft}
            onChange={setDraft}
          />
        </div>

        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("settings.eyebrow.cron")}</p>
            <h3 className="text-xl font-semibold">{t("settings.title.schedulePlan")}</h3>
          </div>
          <SchedulerPlanCard schedule={schedule} />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("settings.eyebrow.auth")}</p>
            <h3 className="text-xl font-semibold">{t("settings.title.biliLogin")}</h3>
          </div>
          <p className="text-sm leading-6 text-[var(--muted)]">
            {t("settings.auth.description")}
          </p>
          <div className="mt-4 grid gap-4">
            <label className="flex flex-col gap-2 text-sm text-[var(--muted)]">
              {t("settings.auth.authFileOverride")}
              <input
                value={loginAuthFile}
                onChange={(event) => {
                  setLoginAuthFile(event.target.value);
                }}
                className="rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
                placeholder={t("settings.auth.placeholder.authFile")}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-[var(--muted)]">
              {t("settings.auth.cookieFileOverride")}
              <input
                value={loginCookieFile}
                onChange={(event) => {
                  setLoginCookieFile(event.target.value);
                }}
                className="rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
                placeholder={t("settings.auth.placeholder.cookieFile")}
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <ActionButton
                label={t("settings.auth.startSession")}
                busy={pendingLoginStart}
                onClick={() => {
                  void startBiliLogin();
                }}
              />
              {loginSession && (loginSession.status === "pending" || loginSession.status === "scanned") ? (
                <ActionButton
                  label={t("settings.auth.cancelSession")}
                  busy={pendingLoginCancel}
                  onClick={() => {
                    void cancelBiliLogin();
                  }}
                />
              ) : null}
            </div>
          </div>
        </div>

        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("settings.eyebrow.session")}</p>
            <h3 className="text-xl font-semibold">{t("settings.title.currentSession")}</h3>
          </div>
          {loginSession ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <StatusPill status={loginSession.status} />
                <span className="text-sm text-[var(--muted)]">{t("common.updatedAt", { value: formatDateTime(loginSession.updatedAt) })}</span>
              </div>
              <KeyValueCard label={t("settings.session.authFile")} value={loginSession.authFile} />
              <KeyValueCard label={t("settings.session.cookieFile")} value={loginSession.cookieFile || "-"} />
              <KeyValueCard label={t("settings.session.mid")} value={loginSession.mid ? String(loginSession.mid) : "-"} />
              {loginSession.loginUrl ? (
                <label className="flex flex-col gap-2 text-sm text-[var(--muted)]">
                  {t("settings.session.loginUrl")}
                  <textarea
                    readOnly
                    value={loginSession.loginUrl}
                    rows={4}
                    className="rounded-[1.2rem] border border-[var(--line)] bg-white/75 px-4 py-3 text-sm leading-6 outline-none"
                  />
                </label>
              ) : null}
              {loginSession.errorMessage ? (
                <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4 text-sm text-[var(--muted)]">
                  {loginSession.errorMessage}
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState text={t("settings.session.empty")} />
          )}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("settings.eyebrow.summary")}</p>
            <h3 className="text-xl font-semibold">{t("settings.title.inference")}</h3>
          </div>
          <ManagedSettingsGroup
            definitions={definitions.filter((item) => item.group === "summary")}
            draft={draft}
            onChange={setDraft}
          />
        </div>

        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("settings.eyebrow.publish")}</p>
            <h3 className="text-xl font-semibold">{t("settings.title.cooldown")}</h3>
          </div>
          <ManagedSettingsGroup
            definitions={definitions.filter((item) => item.group === "publish")}
            draft={draft}
            onChange={setDraft}
          />
        </div>
      </section>

      <section className="glass-panel rounded-[1.6rem]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("settings.eyebrow.history")}</p>
            <h3 className="text-xl font-semibold">{t("settings.title.configHistory")}</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">{t("common.rows", { count: configHistory.length })}</span>
        </div>
        <ConfigHistoryList
          items={configHistory}
          pendingRollbackId={pendingRollbackId}
          onRollback={(item) => {
            if (!window.confirm(t("settings.history.confirm.rollback", { id: item.id }))) {
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
  const { t, formatDateTime } = useUiText();

  if (items.length === 0) {
    return <EmptyState text={t("settings.history.empty")} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.id} className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">#{item.id}</p>
                <StatusPill status={item.status} />
                <span className="status-pill status-waiting">{item.action}</span>
                {item.restartRequiredKeys.length > 0 ? <span className="status-pill status-failed">{t("managedSettings.restart")}</span> : null}
              </div>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {t(`settings.history.reason.${item.reason || "update"}`)} · {item.triggerSource || t("common.web")} · {formatDateTime(item.createdAt)}
                {typeof item.restoredFromAuditId === "number" ? ` · ${t("settings.history.restoredFrom", { id: item.restoredFromAuditId })}` : ""}
              </p>
              <p className="mt-3 text-sm text-[var(--muted)]">
                {item.changedKeys.length > 0 ? item.changedKeys.join(", ") : t("settings.history.changedKeys.empty")}
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
                {pendingRollbackId === item.id ? t("settings.history.button.rollingBack") : t("settings.history.button.rollback")}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RunsPage() {
  const { t } = useUiText();
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
    <div className="flex flex-col gap-4">
      <section className="glass-panel rounded-[1.6rem]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("runs.eyebrow.history")}</p>
            <h2 className="mt-1 text-[1.8rem] font-semibold tracking-[-0.03em]">{t("runs.title.history")}</h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--muted)]">
              {t("runs.description")}
            </p>
          </div>
          <label className="flex min-w-[220px] flex-col gap-2 text-sm text-[var(--muted)]">
            {t("runs.filter.status")}
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setPage(0);
              }}
              className="rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
            >
              <option value="all">{t("runs.filter.all")}</option>
              <option value="running">{t("status.running")}</option>
              <option value="succeeded">{t("status.succeeded")}</option>
              <option value="failed">{t("status.failed")}</option>
              <option value="cancelled">{t("status.cancelled")}</option>
            </select>
          </label>
        </div>
      </section>

      <section className="glass-panel rounded-[1.6rem]">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("pipeline.eyebrow.runs")}</p>
            <h3 className="text-xl font-semibold">{t("runs.title.allRuns")}</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">
            {pageStart}-{pageEnd} / {total}
          </span>
        </div>

        <RunTable items={items} emptyText={t("runs.empty.filtered")} />

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
  const { t, formatDateTime } = useUiText();
  const params = useParams();
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [importSummaryText, setImportSummaryText] = useState("");
  const [importSummarySource, setImportSummarySource] = useState<string | null>(null);
  const [runPage, setRunPage] = useState(0);
  const [eventPage, setEventPage] = useState(0);
  const bvid = String(params.bvid ?? "").trim();
  const runPageSize = 10;
  const eventPageSize = 25;

  useEffect(() => {
    setRunPage(0);
    setEventPage(0);
    setImportSummaryText("");
    setImportSummarySource(null);
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
      setActionMessage(t("pipeline.actionFailed", { message: response.errorMessage || t("common.unknown") }));
      setPendingAction(null);
      await refreshQueries(queryClient, bvid);
      return;
    }

    setActionMessage(t("pipeline.actionAccepted", { auditId: response.auditId }));
    setPendingAction(null);
    await refreshQueries(queryClient, bvid);
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="glass-panel rounded-[1.6rem]">
        <Link to="/" className="text-sm font-medium text-[var(--muted)] transition hover:text-[var(--accent)]">
          {t("common.backToDashboard")}
        </Link>
        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{video?.bvid || bvid}</p>
            <h2 className="mt-2 text-[1.95rem] font-semibold tracking-[-0.04em]">{video?.title || t("pipeline.title.fallback")}</h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--muted)]">
              {detail?.latestRun?.lastMessage || detail?.latestRun?.lastErrorMessage || t("pipeline.description.fallback")}
            </p>
          </div>
          <div className="grid min-w-[260px] gap-3 sm:grid-cols-2">
            <KeyValueCard label={t("pipeline.label.latestStatus")} valueNode={<StatusPill status={detail?.latestRun?.runStatus || "unknown"} />} />
            <KeyValueCard label={t("pipeline.label.currentStage")} value={detail?.latestRun?.currentStage || "-"} />
            <KeyValueCard label={t("pipeline.label.latestUpdate")} value={formatDateTime(detail?.latestRun?.updatedAt)} />
            <KeyValueCard label={t("pipeline.label.rebuildFlag")} value={video?.publish_needs_rebuild ? video.publish_rebuild_reason || t("common.yes") : t("common.no")} />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <ActionButton
            label={t("pipeline.button.syncVideo")}
            busy={pendingAction === "sync-video"}
            onClick={() => {
              void runAction("sync-video", `/api/actions/pipeline/${encodeURIComponent(bvid)}/sync`, {});
            }}
          />
          <ActionButton
            label={t("pipeline.button.retry")}
            busy={pendingAction === "retry"}
            onClick={() => {
              void runAction("retry", `/api/actions/pipeline/${encodeURIComponent(bvid)}/retry`, {});
            }}
          />
          <ActionButton
            label={t("pipeline.button.recoverZombie")}
            busy={pendingAction === "recover-zombie"}
            onClick={() => {
              if (!window.confirm(t("pipeline.confirm.recoverZombie"))) {
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
              label={t("pipeline.button.cancelRun")}
              busy={pendingAction === "cancel"}
              onClick={() => {
                if (!window.confirm(t("pipeline.confirm.cancelRun"))) {
                  return;
                }

                void runAction("cancel", `/api/actions/pipeline/${encodeURIComponent(bvid)}/cancel`, {
                  reason: "manual-cancel",
                });
              }}
            />
          ) : null}
          <ActionButton
            label={t("pipeline.button.publishNow")}
            busy={pendingAction === "publish"}
            onClick={() => {
              if (!window.confirm(t("pipeline.confirm.publishNow"))) {
                return;
              }

              void runAction("publish", `/api/actions/pipeline/${encodeURIComponent(bvid)}/publish`, {
                confirm: true,
              });
            }}
          />
          <ActionButton
            label={t("pipeline.button.markRebuild")}
            busy={pendingAction === "rebuild"}
            onClick={() => {
              if (!window.confirm(t("pipeline.confirm.markRebuild"))) {
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

      <section className="grid gap-4 xl:grid-cols-[1fr_0.8fr]">
        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("pipeline.eyebrow.manual")}</p>
            <h3 className="text-xl font-semibold">{t("pipeline.title.importSummary")}</h3>
          </div>
          <p className="text-sm leading-6 text-[var(--muted)]">
            {t("pipeline.importSummary.description")}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)]">
              {t("pipeline.importSummary.loadFile")}
              <input
                type="file"
                accept=".md,.txt,text/markdown,text/plain"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  if (!file) {
                    return;
                  }

                  void file.text().then((content) => {
                    setImportSummaryText(content);
                    setImportSummarySource(file.name);
                  });
                }}
              />
            </label>
            <ActionButton
              label={t("pipeline.importSummary.button")}
              busy={pendingAction === "import-summary"}
              onClick={() => {
                if (!importSummaryText.trim()) {
                  setActionMessage(t("pipeline.importSummary.failed"));
                  return;
                }

                void runAction("import-summary", `/api/actions/pipeline/${encodeURIComponent(bvid)}/import-summary`, {
                  summaryText: importSummaryText,
                });
              }}
            />
          </div>
          {importSummarySource ? (
            <p className="mt-3 text-sm text-[var(--muted)]">{t("pipeline.importSummary.loadedFile", { name: importSummarySource })}</p>
          ) : null}
          <textarea
            value={importSummaryText}
            onChange={(event) => {
              setImportSummaryText(event.target.value);
              if (importSummarySource) {
                setImportSummarySource(t("pipeline.importSummary.editedInBrowser"));
              }
            }}
            rows={12}
            className="mt-4 w-full rounded-[1.2rem] border border-[var(--line)] bg-white/75 px-4 py-3 text-sm leading-6 outline-none transition focus:border-[var(--accent)]"
            placeholder={"<1P>\n00:00 ...\n\n<2P>\n00:00 ..."}
          />
        </div>

        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("pipeline.eyebrow.repair")}</p>
            <h3 className="text-xl font-semibold">{t("pipeline.title.repairNotes")}</h3>
          </div>
          <div className="flex flex-col gap-3 text-sm leading-6 text-[var(--muted)]">
            <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
              {t("pipeline.repair.syncVideo")}
            </div>
            <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
              {t("pipeline.repair.importSummary")}
            </div>
            <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
              {t("pipeline.repair.validation")}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("pipeline.eyebrow.parts")}</p>
              <h3 className="text-xl font-semibold">{t("pipeline.title.pageStatus")}</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{t("common.pages", { count: detail?.parts.length ?? 0 })}</span>
          </div>
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>{t("pipeline.table.page")}</th>
                  <th>{t("pipeline.table.title")}</th>
                  <th>{t("pipeline.table.summary")}</th>
                  <th>{t("pipeline.table.publish")}</th>
                  <th>{t("pipeline.table.updated")}</th>
                </tr>
              </thead>
              <tbody>
                {(detail?.parts ?? []).map((part) => (
                  <tr key={part.id}>
                    <td className="font-semibold">P{part.page_no}</td>
                    <td>{part.part_title}</td>
                    <td>{part.summary_text_processed || part.summary_text ? t("pipeline.pageStatus.ready") : t("pipeline.pageStatus.pending")}</td>
                    <td>{Number(part.published) === 1 ? t("pipeline.pageStatus.published") : t("pipeline.pageStatus.pending")}</td>
                    <td>{formatDateTime(part.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("pipeline.eyebrow.runs")}</p>
              <h3 className="text-xl font-semibold">{t("pipeline.title.runHistory")}</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{t("common.runs", { count: runsQuery.data?.total ?? detail?.recentRuns.length ?? 0 })}</span>
          </div>
          {runItems.length === 0 ? (
            <EmptyState text={t("pipeline.empty.runs")} />
          ) : (
            <div className="flex flex-col gap-3">
              {runItems.map((run) => (
                <div key={run.runId} className="rounded-[1.2rem] border border-[var(--line)] bg-white/70 px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold">{run.currentStage || run.currentScope || t("pipeline.stage.pipeline")}</p>
                      <p className="mt-1 text-sm text-[var(--muted)]">{formatDateTime(run.updatedAt)}</p>
                    </div>
                    <StatusPill status={run.runStatus} />
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

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("pipeline.eyebrow.timeline")}</p>
              <h3 className="text-xl font-semibold">{t("pipeline.title.timeline")}</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{t("common.events", { count: eventsQuery.data?.total ?? detail?.recentEvents.length ?? 0 })}</span>
          </div>
          {eventItems.length === 0 ? (
            <EmptyState text={t("pipeline.empty.timeline")} />
          ) : (
            <div className="timeline flex flex-col gap-4">
              {eventItems.map((event) => (
                <div key={event.id} className="timeline-item rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusPill status={event.status} />
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

        <div className="glass-panel rounded-[1.6rem]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{t("dashboard.eyebrow.audits")}</p>
              <h3 className="text-xl font-semibold">{t("dashboard.title.manualActions")}</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{t("common.rows", { count: auditItems.length })}</span>
          </div>
          <AuditList items={auditItems} emptyText={t("pipeline.empty.audits")} />
        </div>
      </section>
    </div>
  );
}

function SchedulerStatusCard({ status }: { status: SchedulerStatus | null }) {
  const { t, formatDateTime, formatDuration } = useUiText();

  if (!status) {
    return <EmptyState text={t("scheduler.empty.status")} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <KeyValueCard label={t("scheduler.label.state")} valueNode={<StatusPill status={status.healthy ? "running" : status.status} />} />
      <KeyValueCard label={t("scheduler.label.currentTasks")} value={status.currentTasks.length > 0 ? status.currentTasks.join(", ") : t("common.idle")} />
      <KeyValueCard label={t("scheduler.label.lastHeartbeat")} value={formatDateTime(status.lastHeartbeatAt)} />
      <KeyValueCard label={t("scheduler.label.heartbeatAge")} value={formatDuration(status.heartbeatAgeMs)} />
      <KeyValueCard label={t("scheduler.label.lastRetrySweep")} value={formatDateTime(status.taskTimes["retry-failures"] ?? null)} />
      <KeyValueCard label={t("scheduler.label.concurrency")} value={status.summaryConcurrency ? String(status.summaryConcurrency) : "-"} />
      <KeyValueCard label={t("scheduler.label.lastError")} value={status.lastError || "-"} />
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
  const { t, formatDateTime, formatDuration } = useUiText();

  if (!snapshot) {
    return <EmptyState text={t("healthWatch.empty.snapshot")} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <KeyValueCard label={t("healthWatch.label.critical")} value={String(snapshot.criticalCount)} />
      <KeyValueCard label={t("healthWatch.label.warnings")} value={String(snapshot.warningCount)} />
      <KeyValueCard label={t("healthWatch.label.stalled")} value={String(snapshot.staleRunningCount)} />
      <KeyValueCard label={t("healthWatch.label.heartbeatAge")} value={formatDuration(snapshot.schedulerHeartbeatAgeMs)} />
      {items.length === 0 ? (
        <EmptyState text={t("healthWatch.empty.items")} />
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
              <SeverityPill severity={item.severity} />
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
  const { t, formatDateTime } = useUiText();

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
                {item.bvid || item.scope} · {t("audit.label.audit", { id: item.id })}
              </p>
            </div>
            <StatusPill status={item.status} />
          </div>
          <p className="mt-3 text-sm text-[var(--muted)]">
            {item.errorMessage || describeAuditResult(item.result, t, formatDateTime) || t("common.noResultDetails")}
          </p>
          <p className="mt-2 text-xs uppercase tracking-[0.16em] text-[var(--muted)]">{formatDateTime(item.createdAt)}</p>
        </div>
      ))}
    </div>
  );
}

function FailureGroupList({ items }: { items: FailureGroupItem[] }) {
  const { t, formatDateTime } = useUiText();

  if (items.length === 0) {
    return <EmptyState text={t("audit.empty.failureGroups")} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.key} className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-semibold">{item.failedStep || item.failureCategory}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">{item.failureCategory} · {t("common.runs", { count: item.count })}</p>
            </div>
            <div className="flex items-center gap-2">
              <ResolutionPill resolution={item.resolution} />
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
  const { t, formatDuration } = useUiText();

  if (items.length === 0) {
    return <EmptyState text={t("audit.empty.recoveryCandidates")} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.runId} className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">{item.videoTitle || item.bvid || item.runId}</p>
                <StatusPill status={item.runStatus} />
                <span className="status-pill status-waiting">{item.recoveryState}</span>
              </div>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {t("audit.text.stale", { bvid: item.bvid || "-", duration: formatDuration(item.staleForMs), stage: item.currentStage || "-" })}
              </p>
              <p className="mt-3 text-sm text-[var(--muted)]">{item.recoveryReason}</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {item.recommendedAction === "cancel" ? (
                <ActionButton
                  label={t("audit.button.cancelStale")}
                  busy={pendingAction === `cancel-${item.bvid}`}
                  onClick={() => {
                    onCancel(item);
                  }}
                />
              ) : (
                <ActionButton
                  label={t("pipeline.button.recoverZombie")}
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
                {t("audit.button.openDetail")}
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
  const { t, formatDateTime } = useUiText();

  if (items.length === 0) {
    return <EmptyState text={t("audit.empty.failureQueue")} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.runId} className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">{item.videoTitle || item.bvid || t("table.unknownVideo")}</p>
                <StatusPill status={item.runStatus} />
                <ResolutionPill resolution={item.resolution} />
              </div>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {t("audit.text.failure", {
                  stage: item.failedStep || item.currentStage || t("status.failed"),
                  category: item.failureCategory,
                  updated: formatDateTime(item.updatedAt),
                })}
              </p>
              <p className="mt-3 text-sm text-[var(--muted)]">{item.lastErrorMessage || item.lastMessage || item.resolutionReason}</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {item.bvid ? (
                <Link
                  to={`/pipeline/${encodeURIComponent(item.bvid)}`}
                  className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)]"
                >
                  {t("audit.button.inspect")}
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
                  {pendingAction === `retry-${item.bvid}` ? t("audit.button.retrying") : t("audit.button.retry")}
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
  const { t } = useUiText();

  if (!draft) {
    return <EmptyState text={t("managedSettings.loading")} />;
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
                  {definition.requiresRestart ? <span className="status-pill status-failed">{t("managedSettings.restart")}</span> : <span className="status-pill status-succeeded">{t("managedSettings.hot")}</span>}
                </div>
                <p className="mt-1 text-sm text-[var(--muted)]">{definition.description}</p>
              </div>
            </div>
            <div className="mt-4">{control}</div>
            <p className="mt-3 text-xs leading-5 text-[var(--muted)]">{t("managedSettings.effectiveScope", { scope: definition.effectiveScope })}</p>
          </div>
        );
      })}
    </div>
  );
}

function SchedulerPlanCard({ schedule }: { schedule: SchedulerPlan | null }) {
  const { t } = useUiText();

  if (!schedule) {
    return <EmptyState text={t("schedule.empty")} />;
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
  const { t } = useI18n();

  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)] disabled:cursor-wait disabled:opacity-60"
    >
      {busy ? t("common.working") : label}
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
  const { t } = useI18n();

  return (
    <div className={`flex items-center justify-end gap-3 ${className}`.trim()}>
      <button
        type="button"
        disabled={!canGoPrevious}
        onClick={onPrevious}
        className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t("pagination.previous")}
      </button>
      <button
        type="button"
        disabled={!canGoNext}
        onClick={onNext}
        className="rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t("pagination.next")}
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
  const { t, formatDateTime } = useUiText();

  if (items.length === 0) {
    return <EmptyState text={emptyText} />;
  }

  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>{t("table.video")}</th>
            <th>{t("table.stage")}</th>
            <th>{t("table.latestMessage")}</th>
            <th>{t("table.status")}</th>
            <th>{t("table.updated")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.runId}>
              <td>
                <Link to={`/pipeline/${encodeURIComponent(item.bvid ?? "")}`} className="group block">
                  <div className="font-semibold transition group-hover:text-[var(--accent)]">{item.videoTitle || item.bvid || t("table.unknownVideo")}</div>
                  <div className="mt-1 text-sm text-[var(--muted)]">{item.bvid || "-"} · {item.triggerSource || t("common.cli")}</div>
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
              <td><StatusPill status={item.runStatus} /></td>
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

function StatusPill({ status }: { status: string }) {
  const { tOptional } = useI18n();
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

  return <span className={`status-pill ${className}`}>{tOptional(`status.${normalized}`) || normalized}</span>;
}

function ResolutionPill({ resolution }: { resolution: FailureQueueItem["resolution"] }) {
  const { tOptional } = useI18n();
  const normalized = String(resolution || "inspect").toLowerCase() as FailureQueueItem["resolution"];
  const className = normalized === "retryable"
    ? "status-running"
    : normalized === "manual"
      ? "status-failed"
      : "status-waiting";

  return <span className={`status-pill ${className}`}>{tOptional(`resolution.${normalized}`) || normalized}</span>;
}

function SeverityPill({ severity }: { severity: AttentionItem["severity"] }) {
  const { tOptional } = useI18n();
  const normalized = String(severity || "warning").toLowerCase();
  const className = normalized === "critical" ? "status-failed" : "status-waiting";
  return <span className={`status-pill ${className}`}>{tOptional(`severity.${normalized}`) || normalized}</span>;
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

function formatDateTime(value: string | null | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (!value) {
    return "-";
  }

  const candidate = new Date(value);
  if (Number.isNaN(candidate.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(candidate);
}

function formatDuration(value: number | null | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (value === null || value === undefined) {
    return "-";
  }

  if (value < 1000) {
    return translate(locale, "time.ms", { value });
  }

  return translate(locale, "time.s", { value: (value / 1000).toFixed(1) });
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

function describeAuditResult(
  result: unknown,
  t: (key: string, vars?: Record<string, number | string>) => string,
  formatDateTimeLocal: (value: string | null | undefined) => string,
): string {
  if (!result || typeof result !== "object") {
    return "";
  }

  const payload = result as {
    ok?: unknown;
    action?: unknown;
    reason?: unknown;
    authFile?: unknown;
    updatedAt?: unknown;
    checkedVideos?: unknown;
    newGaps?: unknown;
    notifiedGapCount?: unknown;
    removedDirectories?: unknown;
    missingDirectories?: unknown;
    candidates?: unknown;
    savedPages?: unknown;
    parts?: unknown;
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

  if (typeof payload.notifiedGapCount === "number" || Array.isArray(payload.checkedVideos) || Array.isArray(payload.newGaps)) {
    return t("audit.result.checked", {
      checked: Array.isArray(payload.checkedVideos) ? payload.checkedVideos.length : "-",
      gaps: Array.isArray(payload.newGaps) ? payload.newGaps.length : "-",
      notified: String(payload.notifiedGapCount ?? "-"),
    });
  }

  if (Array.isArray(payload.removedDirectories) || Array.isArray(payload.missingDirectories) || Array.isArray(payload.candidates)) {
    return t("audit.result.removed", {
      removed: Array.isArray(payload.removedDirectories) ? payload.removedDirectories.length : "-",
      missing: Array.isArray(payload.missingDirectories) ? payload.missingDirectories.length : "-",
      candidates: Array.isArray(payload.candidates) ? payload.candidates.length : "-",
    });
  }

  if (Array.isArray(payload.savedPages)) {
    return t("audit.result.savedPages", {
      pages: payload.savedPages.join(", ") || "-",
    });
  }

  if (Array.isArray(payload.parts)) {
    return t("audit.result.syncedPages", { count: payload.parts.length });
  }

  if (payload.action === "skip-refresh") {
    return t("audit.result.skipRefresh", { reason: String(payload.reason ?? "unknown") });
  }

  if (payload.action === "refresh") {
    return t("audit.result.refreshedAuth", {
      value: formatDateTimeLocal(typeof payload.updatedAt === "string" ? payload.updatedAt : null),
    });
  }

  if (payload.marked === true) {
    return t("audit.result.rebuildFlag");
  }

  if (typeof payload.uploads === "number" || typeof payload.failures === "number" || typeof payload.runs === "number") {
    return t("audit.result.publishStats", {
      runs: String(payload.runs ?? "-"),
      uploads: String(payload.uploads ?? "-"),
      failures: String(payload.failures ?? "-"),
    });
  }

  if (typeof payload.queued === "number") {
    return t("audit.result.queuedStats", {
      queued: payload.queued,
      failures: String(payload.failures ?? "-"),
    });
  }

  if (typeof payload.triggered === "number" || typeof payload.skipped === "number" || typeof payload.failed === "number") {
    return t("audit.result.triggerStats", {
      triggered: String(payload.triggered ?? "-"),
      skipped: String(payload.skipped ?? "-"),
      failed: String(payload.failed ?? "-"),
    });
  }

  if (payload.signalSent === true) {
    return t("audit.result.signalSent", {
      suffix: typeof payload.ownerPid === "number" ? t("settings.message.pidSuffix", { pid: payload.ownerPid }) : "",
    });
  }

  if (Array.isArray(payload.generatedPages)) {
    return t("audit.result.generatedPages", { count: payload.generatedPages.length });
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
