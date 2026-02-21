const workerTails = new Map<string, Promise<void>>();
let oneShotWorkerCounter = 0;

export function runInKeyedAsyncWorker<T>(workerKey: string, job: () => Promise<T>): Promise<T> {
  const prior = workerTails.get(workerKey) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(job);
  const tail = run.then(
    () => undefined,
    () => undefined
  );

  workerTails.set(workerKey, tail);
  tail.finally(() => {
    if (workerTails.get(workerKey) === tail) {
      workerTails.delete(workerKey);
    }
  });

  return run;
}

export function runInAsyncWorker<T>(job: () => Promise<T>): Promise<T> {
  oneShotWorkerCounter += 1;
  const workerKey = `ephemeral-worker:${oneShotWorkerCounter}`;
  return runInKeyedAsyncWorker(workerKey, job);
}
