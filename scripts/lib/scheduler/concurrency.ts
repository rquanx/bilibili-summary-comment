import { normalizePipelineUserKey } from "./user-targets";

export const SUMMARY_PIPELINE_MAX_CONCURRENCY = 3;

export interface PipelineUpload {
  mid?: string | number | null;
  [key: string]: unknown;
}

export type PipelineRunResult<TUpload extends PipelineUpload, TResult = unknown> = TUpload & {
  result: TResult;
};

export type PipelineFailureResult<TUpload extends PipelineUpload> = TUpload & {
  message: string;
};

interface RunPipelinesWithConcurrencyOptions<TUpload extends PipelineUpload, TResult> {
  uploads?: TUpload[];
  maxConcurrent?: number;
  userKeyForUpload?: (upload: TUpload) => string;
  runUpload?: (upload: TUpload) => TResult | Promise<TResult>;
}

export async function runPipelinesWithConcurrency<TUpload extends PipelineUpload, TResult = unknown>({
  uploads,
  maxConcurrent = SUMMARY_PIPELINE_MAX_CONCURRENCY,
  userKeyForUpload = (upload) => String(upload?.mid ?? ""),
  runUpload,
}: RunPipelinesWithConcurrencyOptions<TUpload, TResult> = {}) {
  const queue = Array.isArray(uploads)
    ? uploads.map((upload, index) => ({
        upload,
        index,
      }))
    : [];
  const safeMaxConcurrent = Math.max(1, Number(maxConcurrent) || SUMMARY_PIPELINE_MAX_CONCURRENCY);
  const runResults = new Array<PipelineRunResult<TUpload, TResult> | undefined>(queue.length);
  const failureResults = new Array<PipelineFailureResult<TUpload> | undefined>(queue.length);
  const activeUsers = new Set<string>();
  let activeCount = 0;

  if (typeof runUpload !== "function" || queue.length === 0) {
    return {
      runs: [],
      failures: [],
    };
  }

  return new Promise<{ runs: Array<PipelineRunResult<TUpload, TResult>>; failures: Array<PipelineFailureResult<TUpload>> }>((resolve) => {
    const maybeResolve = () => {
      if (queue.length > 0 || activeCount > 0) {
        return false;
      }

      resolve({
        runs: runResults.filter(Boolean),
        failures: failureResults.filter(Boolean),
      });
      return true;
    };

    const scheduleNext = () => {
      while (activeCount < safeMaxConcurrent) {
        const nextIndex = queue.findIndex((item) => {
          const userKey = normalizePipelineUserKey(userKeyForUpload(item.upload));
          return !activeUsers.has(userKey);
        });
        if (nextIndex === -1) {
          break;
        }

        const [{ upload, index }] = queue.splice(nextIndex, 1);
        const userKey = normalizePipelineUserKey(userKeyForUpload(upload));
        activeCount += 1;
        activeUsers.add(userKey);

        Promise.resolve()
          .then(() => runUpload(upload))
          .then((result) => {
            runResults[index] = {
              ...upload,
              result,
            };
          })
          .catch((error) => {
            failureResults[index] = {
              ...upload,
              message: error?.message ?? "Unknown error",
            };
          })
          .finally(() => {
            activeCount -= 1;
            activeUsers.delete(userKey);
            if (!maybeResolve()) {
              scheduleNext();
            }
          });
      }

      maybeResolve();
    };

    scheduleNext();
  });
}
