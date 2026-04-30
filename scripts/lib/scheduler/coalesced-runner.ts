interface CoalescedRunnerOptions<TResult> {
  name: string;
  runningTasks: Set<string>;
  task: () => Promise<TResult> | TResult;
  onLog?: (message: string) => void;
  onFailure?: (error: unknown) => TResult;
  onAfterSuccess?: (result: TResult) => void;
  onStateChange?: () => void;
}

export function createCoalescedRunner<TResult>({
  name,
  runningTasks,
  task,
  onLog = () => {},
  onFailure,
  onAfterSuccess,
  onStateChange,
}: CoalescedRunnerOptions<TResult>) {
  let rerunRequested = false;

  function formatHookError(error: unknown) {
    return error instanceof Error ? error.message : "Unknown error";
  }

  return async () => {
    if (runningTasks.has(name)) {
      rerunRequested = true;
      onLog(`Queue ${name}: previous run still in progress; will rerun immediately after completion`);
      return null;
    }

    runningTasks.add(name);
    onStateChange?.();
    let completedRuns = 0;
    let lastResult: TResult | null = null;

    try {
      do {
        const isQueuedRerun = completedRuns > 0;
        rerunRequested = false;

        if (isQueuedRerun) {
          onLog(`Running queued ${name} rerun`);
        }

        try {
          lastResult = await task();
          if (onAfterSuccess) {
            try {
              onAfterSuccess(lastResult);
            } catch (error) {
              onLog(`Post-success hook for ${name} failed: ${formatHookError(error)}`);
            }
          }
        } catch (error) {
          if (!onFailure) {
            throw error;
          }

          lastResult = onFailure(error);
        }

        completedRuns += 1;
      } while (rerunRequested);

      return lastResult;
    } finally {
      runningTasks.delete(name);
      onStateChange?.();
    }
  };
}
