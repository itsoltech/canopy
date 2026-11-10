// Squirrel shares one native feed across updater instances. Reserve ownership when
// queueing, since an unfinished or failed finalizer may also have changed that feed.
let latestCommit: symbol | undefined;
let finalizing = Promise.resolve();

function serialize(run: () => Promise<void>) {
  const next = finalizing.then(run);
  finalizing = next.catch(() => {});

  return next;
}

/** A staged ZIP's native feed; ordinary installs keep the synchronous Squirrel path. */
export class MacUpdateFeed {
  private token: symbol | undefined;
  constructor(private readonly stage: () => Promise<void>) {}

  private finalize(install?: () => void) {
    const token = Symbol();
    latestCommit = token;

    return serialize(async () => {
      await this.stage();
      this.token = token;
      install?.();
    });
  }
  commit() {
    return this.finalize();
  }
  install(install: () => void, failed: (cause: unknown) => void): void {
    if (this.token && latestCommit === this.token) {
      install();

      return;
    }

    // Local ZIP staging has no transfer progress. Do not apply metadata or network
    // stall deadlines to it; propagate Squirrel/filesystem failures to the caller.
    void this.finalize(install).catch(failed);
  }
}
