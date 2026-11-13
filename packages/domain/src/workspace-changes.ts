import { ThreadFileChangeKind as Kind, type ThreadFilesUpdate, type ui } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { WorkspaceStore } from "./workspace.ts";

interface Scope {
  directories: string[];
  files: string[];
  update: (update: ThreadFilesUpdate) => void;
  status: (message: string) => void;
}

const stores = new WeakMap<WorkspaceStore, WorkspaceChanges>();

/** A single visible-scope stream per thread; no connection or timer for hidden consumers. */
export function workspaceChanges(store: WorkspaceStore) {
  let changes = stores.get(store);

  if (!changes) {
    changes = new WorkspaceChanges(store);
    stores.set(store, changes);
  }

  return changes;
}

class WorkspaceChanges {
  readonly threads = new Map<string, Changes>();
  constructor(readonly store: WorkspaceStore) {
    store.watchFiles((change) => {
      if (change) return;

      for (const thread of this.threads.values()) {
        thread.scopes.clear();
        thread.stop();
      }

      this.threads.clear();
    });
  }

  retain(threadId: string, scope: Scope): () => void {
    let thread = this.threads.get(threadId);

    if (!thread) {
      thread = new Changes(this.store, threadId);
      this.threads.set(threadId, thread);
    }

    const current = thread;
    current.scopes.add(scope);
    current.restart();

    let released = false;

    return () => {
      if (released) return;
      released = true;
      current.scopes.delete(scope);
      current.restart();

      if (!current.scopes.size) this.threads.delete(threadId);
    };
  }
}

class Changes {
  readonly scopes = new Set<Scope>();
  #connection: AbortController | undefined;
  #root = "";
  #cursor = "";
  #queued = false;

  constructor(
    readonly store: WorkspaceStore,
    readonly threadId: string,
  ) {}

  stop() {
    this.#connection?.abort();
    this.#connection = undefined;
  }

  restart() {
    this.stop();

    if (this.#queued || !this.scopes.size) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;

      if (!this.scopes.size) return;
      const connection = new AbortController();
      this.#connection = connection;
      void this.#run(connection.signal);
    });
  }

  async #run(signal: AbortSignal) {
    const watch = this.store.api.watchFiles;

    if (!watch) return;
    const directories = [...new Set([...this.scopes].flatMap((scope) => scope.directories))];
    const files = [...new Set([...this.scopes].flatMap((scope) => scope.files))];

    if (directories.length + files.length > 32) {
      this.#status("Live changes paused. Collapse a directory, then reopen Files.");

      return;
    }

    let retries = 0;

    while (!signal.aborted) {
      const request: MessageInitShape<typeof ui.WatchThreadFilesRequestSchema> = {
        threadId: this.threadId,
        directories,
        files,
        rootIdentity: this.#root,
        cursor: this.#cursor,
      };

      try {
        await watch(request, signal, (update) => {
          if (signal.aborted) return;
          this.#root = update.rootIdentity;
          this.#cursor = update.cursor;
          retries = 0;
          this.#status("");

          for (const scope of this.scopes) scope.update(update);

          if (update.changes.some((change) => change.kind === Kind.ROOT_CHANGED)) this.stop();
        });
      } catch {
        if (signal.aborted) return;
      }

      if (signal.aborted) return;
      this.#status("Live changes are unavailable. Reconnect or reload to check the disk.");
      await wait(Math.min(15_000, 1000 * 2 ** Math.min(retries++, 4)), signal);
    }
  }

  #status(message: string) {
    for (const scope of this.scopes) scope.status(message);
  }
}

function wait(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };

    const timer = setTimeout(done, delay);
    signal.addEventListener("abort", done, { once: true });

    if (signal.aborted) done();
  });
}

export function observeWorkspaceFile(store: WorkspaceStore, document: import("./workspace-file.ts").WorkspaceFile) {
  const path = document.file?.relativePath;

  if (!path) return () => {};

  const release = workspaceChanges(store).retain(document.target.threadId, {
    directories: [],
    files: [path],
    update: (update) => {
      if (update.changes.some((change) => change.kind === Kind.ROOT_CHANGED)) {
        document.invalidateRoot();

        return;
      }

      if (!document.checkRoot(update.rootIdentity)) return;

      if (
        update.revalidateRequired ||
        update.changes.some((change) => change.kind !== Kind.DIRECTORY_INVALIDATED && change.path === path)
      )
        void document.revalidate();
    },
    status: (message) => {
      document.watchStatus = message;
      document.changed();
    },
  });

  return () => {
    release();
    document.cancel();
  };
}
