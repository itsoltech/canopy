import { Effect, Semaphore } from "effect";

/** Serialize admission and release per thread without holding up another thread's work. */
export function threadLifecycle<E>(unavailable: (threadId: string) => E) {
  const entries = new Map<string, { lock: Semaphore.Semaphore; closing: boolean }>();

  const entryFor = (threadId: string) => {
    let entry = entries.get(threadId);

    if (!entry) {
      entry = { lock: Semaphore.makeUnsafe(1), closing: false };
      entries.set(threadId, entry);
    }

    return entry;
  };

  return {
    run: <A>(threadId: string, work: (current: () => boolean) => Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        const entry = entryFor(threadId);
        const current = () => !entry.closing;

        return Effect.suspend(() => (current() ? work(current) : Effect.fail(unavailable(threadId)))).pipe(
          entry.lock.withPermit,
        );
      }),
    unload: (threadId: string, close: Effect.Effect<void, E>, stop: () => void = () => {}) =>
      Effect.suspend(() => {
        const entry = entryFor(threadId);
        entry.closing = true;
        stop();

        return Effect.suspend(() => (entries.get(threadId) === entry ? close : Effect.void)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (entries.get(threadId) === entry) entries.delete(threadId);
            }),
          ),
          entry.lock.withPermit,
          Effect.uninterruptible,
        );
      }),
  };
}
