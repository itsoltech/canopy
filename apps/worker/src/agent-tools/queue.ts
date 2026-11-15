/** CLI daemons and npm prefixes are shared by every AgentTools instance in this worker. */
const tails = new Map<string, Promise<void>>();

export function serializeAgentTool<T>(key: string, run: () => Promise<T>, maxQueueMs?: number): Promise<T> {
  let expired = false;
  let admitted = false;

  const task = (tails.get(key) ?? Promise.resolve()).then(() => {
    admitted = true;

    if (expired) throw new Error("Automation tool is busy; retry when the current operation finishes");

    return run();
  });

  const tail = task.then(
    () => undefined,
    () => undefined,
  );

  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });

  if (maxQueueMs === undefined) return task;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!admitted) {
        expired = true;
        reject(new Error("Automation tool is busy; retry when the current operation finishes"));
      }
    }, maxQueueMs);

    void task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
