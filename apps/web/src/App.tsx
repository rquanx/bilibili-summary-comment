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
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">运维观察后台</h1>
          </div>
          <Link
            to="/"
            className="rounded-full border border-[var(--line)] bg-white/70 px-4 py-2 text-sm font-medium text-[var(--ink)] transition hover:-translate-y-0.5 hover:border-[var(--accent)]"
          >
            Dashboard
          </Link>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-[var(--muted)] sm:text-base">
          聚合活跃流水线、最近运行结果和单视频时间线，替代滚动日志作为第一观察面。
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
            return Array.isArray(query.queryKey) && query.queryKey[0] === "dashboard";
          },
        });

        if (location.pathname.startsWith("/pipeline/")) {
          const bvid = decodeURIComponent(location.pathname.split("/").pop() ?? "");
          if (bvid) {
            void queryClient.invalidateQueries({
              queryKey: ["pipeline", bvid],
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
  const deferredFilter = useDeferredValue(filter.trim().toLowerCase());
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

  const summary = summaryQuery.data?.summary;
  const activeItems = (activeQuery.data?.items ?? []).filter((item) => matchesRunFilter(item, deferredFilter));
  const recentItems = (recentQuery.data?.items ?? []).filter((item) => matchesRunFilter(item, deferredFilter));
  const failedItems = recentItems.filter((item) => item.runStatus === "failed").slice(0, 12);

  return (
    <div className="flex flex-col gap-6">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="活跃流水线" value={summary?.activeCount ?? 0} tone="accent" />
        <MetricCard title="24h 成功" value={summary?.succeededCount24h ?? 0} tone="success" />
        <MetricCard title="24h 失败" value={summary?.failedCount24h ?? 0} tone="danger" />
        <MetricCard title="最新更新" value={formatDateTime(summary?.latestUpdatedAt)} tone="neutral" />
      </section>

      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">board</p>
            <h2 className="mt-1 text-2xl font-semibold">活跃任务与最近结果</h2>
          </div>
          <label className="flex w-full max-w-sm flex-col gap-2 text-sm text-[var(--muted)]">
            过滤 `bvid` / 标题
            <input
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
              }}
              className="rounded-2xl border border-[var(--line)] bg-white/75 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
              placeholder="例如 BV1Zk9eBFEEk"
            />
          </label>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">active</p>
              <h3 className="text-xl font-semibold">活跃流水线</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{activeItems.length} 条</span>
          </div>
          <RunTable items={activeItems} emptyText="当前没有活跃流水线" />
        </div>

        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">failures</p>
              <h3 className="text-xl font-semibold">最近失败</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{failedItems.length} 条</span>
          </div>
          <div className="flex flex-col gap-3">
            {failedItems.length === 0 ? (
              <EmptyState text="最近窗口内没有失败任务" />
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
            <h3 className="text-xl font-semibold">最近运行</h3>
          </div>
          <span className="text-sm text-[var(--muted)]">{recentItems.length} 条</span>
        </div>
        <RunTable items={recentItems} emptyText="没有可展示的最近运行记录" />
      </section>
    </div>
  );
}

function PipelineDetailPage() {
  const params = useParams();
  const bvid = String(params.bvid ?? "").trim();
  const detailQuery = useQuery({
    queryKey: ["pipeline", bvid],
    enabled: Boolean(bvid),
    queryFn: async () => fetchJson<{ ok: true; detail: PipelineDetailResponse }>(`/api/dashboard/pipeline/${encodeURIComponent(bvid)}`),
  });

  const detail = detailQuery.data?.detail;
  const video = detail?.video;

  return (
    <div className="flex flex-col gap-6">
      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <Link to="/" className="text-sm font-medium text-[var(--muted)] transition hover:text-[var(--accent)]">
          ← 返回 Dashboard
        </Link>
        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{video?.bvid || bvid}</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight">{video?.title || "Pipeline Detail"}</h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--muted)]">
              {detail?.latestRun?.lastMessage || detail?.latestRun?.lastErrorMessage || "查看该视频最近运行、分 P 处理状态与事件时间线。"}
            </p>
          </div>
          <div className="grid min-w-[260px] gap-3 sm:grid-cols-2">
            <KeyValueCard label="最近状态" valueNode={renderStatus(detail?.latestRun?.runStatus || "unknown")} />
            <KeyValueCard label="当前阶段" value={detail?.latestRun?.currentStage || "-"} />
            <KeyValueCard label="最近更新" value={formatDateTime(detail?.latestRun?.updatedAt)} />
            <KeyValueCard label="发布重建" value={video?.publish_needs_rebuild ? video.publish_rebuild_reason || "yes" : "no"} />
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">parts</p>
              <h3 className="text-xl font-semibold">分 P 状态</h3>
            </div>
            <span className="text-sm text-[var(--muted)]">{detail?.parts.length ?? 0} 个分 P</span>
          </div>
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>P</th>
                  <th>标题</th>
                  <th>摘要</th>
                  <th>发布</th>
                  <th>更新时间</th>
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
              <h3 className="text-xl font-semibold">最近运行</h3>
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

      <section className="glass-panel rounded-[1.6rem] p-5 sm:p-6">
        <div className="mb-4">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">timeline</p>
          <h3 className="text-xl font-semibold">最近事件</h3>
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
      </section>
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
            <th>视频</th>
            <th>阶段</th>
            <th>最近消息</th>
            <th>状态</th>
            <th>更新时间</th>
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
