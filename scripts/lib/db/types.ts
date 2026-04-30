import type { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export interface VideoIdentity {
  bvid?: string | null;
  aid?: number | null;
}

export interface VideoRecord {
  id: number;
  bvid: string;
  aid: number;
  title: string;
  owner_mid: number | null;
  owner_name: string | null;
  owner_dir_name: string | null;
  work_dir_name: string | null;
  page_count: number;
  root_comment_rpid: number | null;
  top_comment_rpid: number | null;
  publish_needs_rebuild: number;
  publish_rebuild_reason: string | null;
  last_scan_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VideoInsert {
  bvid: string;
  aid: number;
  title: string;
  ownerMid?: number | null;
  ownerName?: string | null;
  ownerDirName?: string | null;
  workDirName?: string | null;
  pageCount: number;
  rootCommentRpid?: number | null;
  topCommentRpid?: number | null;
}

export interface VideoPartRecord {
  id: number;
  video_id: number;
  page_no: number;
  cid: number;
  part_title: string;
  duration_sec: number;
  subtitle_path: string | null;
  subtitle_source: string | null;
  subtitle_lang: string | null;
  summary_text: string | null;
  summary_text_processed: string | null;
  summary_hash: string | null;
  published: number;
  published_comment_rpid: number | null;
  published_at: string | null;
  is_deleted: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VideoPartUpsert {
  videoId: number;
  pageNo: number;
  cid: number;
  partTitle: string;
  durationSec: number;
  subtitlePath?: string | null;
  subtitleSource?: string | null;
  subtitleLang?: string | null;
  summaryText?: string | null;
  processedSummaryText?: string | null;
  summaryHash?: string | null;
  published?: boolean | number;
  publishedCommentRpid?: number | null;
  publishedAt?: string | null;
  isDeleted?: boolean | number;
  deletedAt?: string | null;
}

export interface VideoSnapshotPage {
  pageNo: number;
  cid: number;
  partTitle: string;
  durationSec: number;
}

export interface VideoSnapshot {
  bvid: string;
  aid: number;
  title: string;
  pageCount: number;
  ownerMid?: number | null;
  ownerName?: string | null;
  pages: VideoSnapshotPage[];
}

export interface SnapshotChangeSet {
  inserted: Array<{ cid: number; pageNo: number }>;
  deleted: Array<{ cid: number; pageNo: number }>;
  moved: Array<{ cid: number; fromPageNo: number; toPageNo: number }>;
  previousCids: number[];
  nextCids: number[];
  sameSequence: boolean;
  appendOnly: boolean;
  requiresRebuild: boolean;
  rebuildReason: string | null;
}

export interface VideoState {
  video: VideoRecord;
  parts: VideoPartRecord[];
  pendingSummaryParts: VideoPartRecord[];
  pendingPublishParts: VideoPartRecord[];
  changeSet?: SnapshotChangeSet;
}

export interface SummaryArtifacts {
  summaryPath: string;
  pendingSummaryPath: string;
}

export interface PipelineEventInput {
  runId?: string | null;
  videoId?: number | null;
  bvid?: string | null;
  videoTitle?: string | null;
  triggerSource?: string | null;
  pageNo?: number | null;
  cid?: number | null;
  partTitle?: string | null;
  scope: string;
  action: string;
  status: string;
  message?: string | null;
  details?: unknown;
}

export interface PipelineEventRecord {
  id: number;
  run_id: string | null;
  video_id: number | null;
  bvid: string | null;
  video_title: string | null;
  page_no: number | null;
  cid: number | null;
  part_title: string | null;
  scope: string;
  action: string;
  status: string;
  message: string | null;
  details_json: string | null;
  created_at: string;
}

export interface PipelineRunRecord {
  run_id: string;
  video_id: number | null;
  bvid: string | null;
  video_title: string | null;
  trigger_source: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PipelineRunStateRecord {
  run_id: string;
  latest_event_id: number;
  video_id: number | null;
  bvid: string | null;
  video_title: string | null;
  trigger_source: string | null;
  run_status: string;
  current_scope: string | null;
  current_action: string | null;
  current_status: string | null;
  current_stage: string | null;
  current_page_no: number | null;
  current_cid: number | null;
  current_part_title: string | null;
  last_message: string | null;
  last_error_message: string | null;
  failed_scope: string | null;
  failed_action: string | null;
  failed_step: string | null;
  log_path: string | null;
  summary_path: string | null;
  pending_summary_path: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

export interface GapNotificationRecord {
  id: number;
  gap_key: string;
  bvid: string;
  video_title: string | null;
  from_page_no: number;
  from_cid: number;
  to_page_no: number;
  to_cid: number;
  gap_start_at: string;
  gap_end_at: string;
  gap_seconds: number;
  notified_at: string;
  created_at: string;
  updated_at: string;
}

export interface GapNotificationInsert {
  gapKey: string;
  bvid: string;
  videoTitle?: string | null;
  fromPageNo: number;
  fromCid: number;
  toPageNo: number;
  toCid: number;
  gapStartAt: string;
  gapEndAt: string;
  gapSeconds: number;
  notifiedAt?: string | null;
}

export interface PipelineEventLogger {
  runId: string;
  log(event: PipelineEventInput): PipelineEventRecord | null;
}
