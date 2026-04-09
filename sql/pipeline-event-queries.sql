-- Pipeline inspection queries for work/pipeline.sqlite3
--
-- Recommended parameters when your SQLite client supports named bindings:
--   :bvid        = NULL            -- or 'BV1xxxxxxx'
--   :since_hours = 12              -- recent window in hours
--   :limit_rows  = 50              -- max rows for event listings
--
-- If your client does not support bindings, replace :bvid / :since_hours / :limit_rows manually.


-- 1. Next pending part
-- Shows the earliest currently pending page, which is usually the next item the pipeline will try to handle.
SELECT
  v.bvid,
  v.title AS video_title,
  p.page_no,
  p.cid,
  p.part_title,
  p.subtitle_source,
  p.updated_at
FROM video_parts p
JOIN videos v ON v.id = p.video_id
WHERE p.is_deleted = 0
  AND (p.summary_text IS NULL OR TRIM(p.summary_text) = '')
  AND (:bvid IS NULL OR v.bvid = :bvid)
ORDER BY v.updated_at DESC, v.id DESC, p.page_no ASC
LIMIT 1;


-- 2. Current pending parts
-- Full pending queue in the order the current pipeline logic is most likely to encounter it.
SELECT
  v.bvid,
  v.title AS video_title,
  p.page_no,
  p.cid,
  p.part_title,
  p.subtitle_source,
  CASE
    WHEN p.subtitle_path IS NOT NULL AND TRIM(p.subtitle_path) <> '' THEN 1
    ELSE 0
  END AS has_subtitle_file,
  p.updated_at
FROM video_parts p
JOIN videos v ON v.id = p.video_id
WHERE p.is_deleted = 0
  AND (p.summary_text IS NULL OR TRIM(p.summary_text) = '')
  AND (:bvid IS NULL OR v.bvid = :bvid)
ORDER BY v.updated_at DESC, v.id DESC, p.page_no ASC;


-- 3. Recent event order
-- Best view for "task processing sequence" across subtitle, LLM summary, and publish actions.
WITH recent_events AS (
  SELECT *
  FROM pipeline_events
  WHERE created_at >= datetime('now', printf('-%d hours', COALESCE(:since_hours, 12)))
    AND (:bvid IS NULL OR bvid = :bvid)
)
SELECT
  created_at,
  run_id,
  bvid,
  video_title,
  page_no,
  cid,
  part_title,
  scope,
  action,
  status,
  message,
  details_json
FROM recent_events
ORDER BY created_at ASC, id ASC
LIMIT COALESCE(:limit_rows, 50);


-- 4. Runs still in progress
-- Finds runs that have a pipeline/run started event but no terminal succeeded/failed pipeline/run event yet.
WITH started_runs AS (
  SELECT
    run_id,
    MAX(created_at) AS started_at
  FROM pipeline_events
  WHERE scope = 'pipeline'
    AND action = 'run'
    AND status = 'started'
    AND (:bvid IS NULL OR bvid = :bvid)
  GROUP BY run_id
),
finished_runs AS (
  SELECT DISTINCT run_id
  FROM pipeline_events
  WHERE scope = 'pipeline'
    AND action = 'run'
    AND status IN ('succeeded', 'failed')
)
SELECT
  s.run_id,
  s.started_at,
  e.bvid,
  e.video_title
FROM started_runs s
JOIN pipeline_events e
  ON e.run_id = s.run_id
 AND e.scope = 'pipeline'
 AND e.action = 'run'
 AND e.status = 'started'
LEFT JOIN finished_runs f ON f.run_id = s.run_id
WHERE f.run_id IS NULL
ORDER BY s.started_at DESC;


-- 5. Duplicate successful subtitle work
-- Helps spot pages that were transcribed successfully more than once.
SELECT
  bvid,
  video_title,
  page_no,
  part_title,
  COUNT(*) AS success_count,
  COUNT(DISTINCT run_id) AS run_count,
  MIN(created_at) AS first_success_at,
  MAX(created_at) AS last_success_at
FROM pipeline_events
WHERE scope = 'subtitle'
  AND action = 'asr'
  AND status = 'succeeded'
  AND (:bvid IS NULL OR bvid = :bvid)
GROUP BY bvid, video_title, page_no, part_title
HAVING COUNT(*) > 1
ORDER BY success_count DESC, last_success_at DESC;


-- 6. Duplicate successful LLM summaries
-- Helps spot pages that were summarized successfully more than once.
SELECT
  bvid,
  video_title,
  page_no,
  part_title,
  COUNT(*) AS success_count,
  COUNT(DISTINCT run_id) AS run_count,
  MIN(created_at) AS first_success_at,
  MAX(created_at) AS last_success_at
FROM pipeline_events
WHERE scope = 'summary'
  AND action = 'llm'
  AND status = 'succeeded'
  AND (:bvid IS NULL OR bvid = :bvid)
GROUP BY bvid, video_title, page_no, part_title
HAVING COUNT(*) > 1
ORDER BY success_count DESC, last_success_at DESC;


-- 7. Duplicate successful publish actions
-- Distinguishes append vs rebuild by reading details_json.publishMode.
SELECT
  bvid,
  video_title,
  json_extract(details_json, '$.publishMode') AS publish_mode,
  COUNT(*) AS success_count,
  COUNT(DISTINCT run_id) AS run_count,
  MIN(created_at) AS first_success_at,
  MAX(created_at) AS last_success_at
FROM pipeline_events
WHERE scope = 'publish'
  AND action = 'comment-thread'
  AND status = 'succeeded'
  AND (:bvid IS NULL OR bvid = :bvid)
GROUP BY bvid, video_title, json_extract(details_json, '$.publishMode')
HAVING COUNT(*) > 1
ORDER BY success_count DESC, last_success_at DESC;


-- 8. Publish mode stats
-- Overall append vs rebuild count.
SELECT
  COALESCE(json_extract(details_json, '$.publishMode'), 'unknown') AS publish_mode,
  COUNT(*) AS success_count
FROM pipeline_events
WHERE scope = 'publish'
  AND action = 'comment-thread'
  AND status = 'succeeded'
  AND (:bvid IS NULL OR bvid = :bvid)
GROUP BY COALESCE(json_extract(details_json, '$.publishMode'), 'unknown')
ORDER BY success_count DESC, publish_mode ASC;


-- 9. Latest event per page
-- Good for a compact status board per page.
WITH ranked AS (
  SELECT
    e.*,
    ROW_NUMBER() OVER (
      PARTITION BY e.bvid, e.page_no
      ORDER BY e.created_at DESC, e.id DESC
    ) AS rn
  FROM pipeline_events e
  WHERE e.page_no IS NOT NULL
    AND (:bvid IS NULL OR e.bvid = :bvid)
)
SELECT
  bvid,
  video_title,
  page_no,
  part_title,
  scope,
  action,
  status,
  message,
  created_at
FROM ranked
WHERE rn = 1
ORDER BY created_at DESC, bvid ASC, page_no ASC;
