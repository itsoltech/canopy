import { create, toBinary } from "@bufbuild/protobuf";
import { watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ThreadFilesUpdateSchema,
  ThreadFileChangeKind as Kind,
  type ThreadFilesWatch,
  type ThreadFileChange,
  type ThreadFilesUpdate,
  ThreadFileChangeSchema,
} from "@canopy/contracts";
import { git } from "../git/git.ts";
import { CommandError } from "../runtime/host-types.ts";
import { directoryPath } from "./thread-directory-path.ts";
import { invalidateDirectoryGit } from "./directory-git.ts";

interface Subscriber {
  request: ThreadFilesWatch;
  send: (update: ThreadFilesUpdate) => void;
  signal: AbortSignal;
}

interface Record {
  sequence: number;
  change: ThreadFileChange;
  bytes: number;
}

/** One coordinator per owner/checkout. Native watches are nonrecursive and shared by visible scopes. */
export class CheckoutFiles {
  readonly subscribers = new Map<string, Subscriber>();
  readonly epoch = crypto.randomUUID();
  readonly watchers = new Map<string, FSWatcher>();
  readonly history: Record[] = [];
  #pending = new Map<string, { directory: string; name: string }>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sequence = 0;
  #bytes = 0;
  #overflow = false;
  #closed = false;
  #git: FSWatcher | undefined;
  #gitStarted = false;
  #tail: Promise<void> = Promise.resolve();
  #adding = 0;

  constructor(
    readonly workspace: string,
    readonly rootIdentity: string,
  ) {}

  get cursor() {
    return `${this.epoch}:${this.#sequence}`;
  }

  get idle() {
    return !this.subscribers.size && !this.#adding;
  }

  async add(request: ThreadFilesWatch, send: Subscriber["send"], signal: AbortSignal) {
    this.#adding++;
    const subscriber: Subscriber = { request, send, signal };

    const cancel = () => {
      if (this.subscribers.get(request.subscriptionId) === subscriber) this.remove(request.subscriptionId);
    };

    signal.addEventListener("abort", cancel, { once: true });

    // Serialise native handle changes, including concurrent subscriptions to the same checkout.
    const operation = this.#tail.then(async () => {
      if (signal.aborted) return;

      if (this.#closed) throw new CommandError("WATCH_CLOSED", "Reopen Files to watch changes.", true);
      this.subscribers.set(request.subscriptionId, subscriber);

      try {
        await this.#reconcile();

        if (this.#closed || signal.aborted) return;
        this.#replay(request, send);
      } catch (cause) {
        cancel();
        throw cause;
      } finally {
        if (signal.aborted) cancel();
        this.#prune();
      }
    });

    this.#tail = operation.catch(() => {});

    try {
      await operation;
    } finally {
      signal.removeEventListener("abort", cancel);
      this.#adding--;
      this.#prune();

      if (this.idle) this.close();
    }
  }

  remove(id: string) {
    this.subscribers.delete(id);
    this.#prune();

    if (this.idle) this.close();
  }

  #prune() {
    const wanted = this.#directories();

    for (const [path, watcher] of this.watchers)
      if (!wanted.has(path)) {
        watcher.close();
        this.watchers.delete(path);
      }
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;

    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.#git?.close();
    this.#git = undefined;
    this.#pending.clear();
    this.history.length = 0;
    this.#bytes = 0;
    this.subscribers.clear();
  }

  #directories() {
    const wanted = new Set<string>();

    for (const { request } of this.subscribers.values()) {
      wanted.add("");

      for (const path of request.directories) wanted.add(path);

      for (const path of request.files) wanted.add(dirname(path) === "." ? "" : dirname(path));
    }

    return wanted;
  }

  async #reconcile() {
    const wanted = this.#directories();

    if (wanted.size > 32) throw new CommandError("WATCH_LIMIT", "Collapse a directory to watch more files.", false);

    for (const directory of wanted) {
      if (this.watchers.has(directory)) continue;
      const target = await directoryPath(this.workspace, directory);

      if (this.#closed) return;

      if (!this.#directories().has(directory)) continue;

      if (target.rootIdentity !== this.rootIdentity) throw new Error("Working directory changed");
      const watcher = watch(target.path, { persistent: false }, (_event, name) => this.#schedule(directory, name));
      watcher.on("error", () => this.#schedule(directory, null));
      this.watchers.set(directory, watcher);
      // Close the lookup/watch race before reporting the initial checkpoint.
      const current = await directoryPath(this.workspace, directory);
      this.#prune();

      if (current.path !== target.path || current.revision !== target.revision) this.#schedule(directory, null);
    }

    if (!this.#gitStarted) {
      this.#gitStarted = true;
      const result = await git(this.workspace, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"], 2000);

      if (this.#closed || !result.ok) return;

      try {
        this.#git = watch(result.stdout.trim(), { persistent: false }, (_event, name) => {
          if (!name || ["HEAD", "index", "packed-refs"].includes(name)) this.#schedule("", null);
        });
        this.#git.on("error", () => this.#schedule("", null));
      } catch {
        this.#schedule("", null);
      }
    }
  }

  #schedule(directory: string, name: string | null) {
    if (this.#closed) return;

    if (!name || name.length > 255 || name.includes("/") || name.includes("\\") || name.includes("\0"))
      this.#overflow = true;
    else if (name !== ".git" && name !== "." && name !== "..") {
      if (this.#pending.size >= 256) this.#overflow = true;
      else this.#pending.set(`${directory}/${name}`, { directory, name });
    }

    if (!this.#timer) {
      this.#timer = setTimeout(() => void this.#flush(), 150);
      this.#timer.unref();
    }
  }

  async #flush() {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    const overflow = this.#overflow;
    this.#overflow = false;

    try {
      const root = await directoryPath(this.workspace, "");

      if (root.rootIdentity !== this.rootIdentity) throw new Error("Working directory changed");
      invalidateDirectoryGit(root.root);
      const changes = new Map<string, ThreadFileChange>();

      for (const { directory, name } of pending) {
        // Revalidate each directory after events; a replaced symlink never broadens the watch scope.
        await directoryPath(this.workspace, directory);
        const path = directory ? `${directory}/${name}` : name;
        const info = await lstat(join(root.root, path)).catch(() => undefined);
        changes.set(
          `d:${directory}`,
          create(ThreadFileChangeSchema, { kind: Kind.DIRECTORY_INVALIDATED, path: directory }),
        );
        changes.set(
          `f:${path}`,
          create(ThreadFileChangeSchema, {
            kind: info ? Kind.FILE_CHANGED : Kind.FILE_REMOVED,
            path,
          }),
        );
      }

      if (this.#closed) return;

      if (overflow) this.#record(create(ThreadFileChangeSchema));

      for (const change of changes.values()) this.#record(change);

      for (const { request, send } of this.subscribers.values()) {
        const selected = [...changes.values()].filter((change) => this.#matches(request, change));
        this.#send(request, send, selected, overflow);
      }
    } catch {
      if (!this.#closed) {
        for (const { request, send } of this.subscribers.values())
          this.#send(request, send, [create(ThreadFileChangeSchema, { kind: Kind.ROOT_CHANGED })], true);
        this.close();
      }
    } finally {
      this.#timer = undefined;

      if (this.#pending.size || this.#overflow) this.#schedule("", null);
    }
  }

  #record(change: ThreadFileChange) {
    const bytes = toBinary(ThreadFileChangeSchema, change).byteLength + 16;
    this.history.push({ sequence: ++this.#sequence, change, bytes });
    this.#bytes += bytes;

    while (this.history.length > 256 || this.#bytes > 256 * 1024) this.#bytes -= this.history.shift()!.bytes;
  }

  #matches(request: ThreadFilesWatch, change: ThreadFileChange) {
    return change.kind === Kind.DIRECTORY_INVALIDATED
      ? request.directories.includes(change.path)
      : request.files.includes(change.path);
  }

  #replay(request: ThreadFilesWatch, send: Subscriber["send"]) {
    const prefix = `${this.epoch}:`;
    const sequence = request.cursor.startsWith(prefix) ? Number(request.cursor.slice(prefix.length)) : -1;
    const oldest = this.history[0]?.sequence ?? this.#sequence + 1;

    const stale =
      request.rootIdentity !== this.rootIdentity ||
      !Number.isSafeInteger(sequence) ||
      sequence < oldest - 1 ||
      sequence > this.#sequence ||
      this.history.some((record) => record.sequence > sequence && record.change.kind === Kind.UNSPECIFIED);

    this.#send(
      request,
      send,
      stale
        ? []
        : this.history.filter((r) => r.sequence > sequence && this.#matches(request, r.change)).map((r) => r.change),
      stale,
    );
  }

  #send(request: ThreadFilesWatch, send: Subscriber["send"], changes: ThreadFileChange[], revalidateRequired: boolean) {
    const subscriber = this.subscribers.get(request.subscriptionId);

    if (this.#closed || subscriber?.request !== request || subscriber.signal.aborted) return;

    if (changes.length > 64) {
      changes = [];
      revalidateRequired = true;
    }

    const update = create(ThreadFilesUpdateSchema, {
      subscriptionId: request.subscriptionId,
      rootIdentity: this.rootIdentity,
      cursor: this.cursor,
      changes,
      revalidateRequired,
    });

    if (toBinary(ThreadFilesUpdateSchema, update).byteLength > 63 * 1024) {
      update.changes = [];
      update.revalidateRequired = true;
    }

    send(update);
  }
}
