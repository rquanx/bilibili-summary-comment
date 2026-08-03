interface PriorityTaskLimiterOptions {
  maxConcurrent: number;
}

interface QueuedTask {
  priority: number;
  sequence: number;
  task: () => Promise<unknown> | unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export const PIPELINE_TASK_PRIORITY = {
  recent: 0,
  historical: 10,
} as const;

export function createPriorityTaskLimiter({
  maxConcurrent,
}: PriorityTaskLimiterOptions) {
  const capacity = Math.max(1, Math.floor(Number(maxConcurrent) || 1));
  const queue: QueuedTask[] = [];
  let activeCount = 0;
  let nextSequence = 0;

  function drain() {
    while (activeCount < capacity && queue.length > 0) {
      queue.sort((left, right) => (
        left.priority - right.priority
        || left.sequence - right.sequence
      ));
      const next = queue.shift();
      if (!next) {
        return;
      }

      activeCount += 1;
      Promise.resolve()
        .then(next.task)
        .then(next.resolve, next.reject)
        .finally(() => {
          activeCount -= 1;
          drain();
        });
    }
  }

  function run<T>(
    priority: number,
    task: () => Promise<T> | T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({
        priority: Number.isFinite(priority) ? priority : 0,
        sequence: nextSequence,
        task,
        resolve(value) {
          resolve(value as T);
        },
        reject,
      });
      nextSequence += 1;
      drain();
    });
  }

  return {
    capacity,
    run,
  };
}
