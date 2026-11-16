import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  ThreadDiffError as Failure,
  ThreadDiffPageSchema,
  ThreadDiffSnapshotSchema,
  type ListThreadDiff,
  type ReadThreadDiff,
} from "@canopy/contracts";
import { ProcessTimeoutError } from "@canopy/process-governor";
import { CommandError } from "../runtime/host-types.ts";
import { directoryPath } from "./thread-directory-path.ts";
import { buildDiff } from "./diff-build.ts";
import { DIFF_TTL, DiffLimit } from "./diff-process.ts";
import { readDiffSpool, type DiffSpool } from "./diff-spool.ts";
import { diffRefused, validDiffPath } from "./diff-source.ts";

interface Snapshot {
  id: string;
  ownerId: string;
  threadId: string;
  workspace: string;
  rootIdentity: string;
  directory: string;
  spools: Map<string, DiffSpool>;
  timer: ReturnType<typeof setTimeout>;
}

interface Opening {
  threadId: string;
  controller: AbortController;
  pending?: Promise<void>;
}

/** Four immutable, disk-spooled snapshots. Absolute TTL bounds disk usage even without a reader. */
export class ThreadDiffs {
  readonly #snapshots = new Map<string, Snapshot>();
  readonly #opening = new Set<Opening>();
  readonly #requests = new Map<string, ReturnType<ThreadDiffs["list"]>>();
  readonly #baseDirectory: string;

  constructor(dataDir: string) {
    this.#baseDirectory = join(dataDir, "diff-snapshots");
    // This directory belongs exclusively to this worker. Restart removes snapshots left by a crash.
    rmSync(this.#baseDirectory, { recursive: true, force: true });
    mkdirSync(this.#baseDirectory, { recursive: true, mode: 0o700 });
  }

  list(request: ListThreadDiff): Promise<import("@canopy/contracts").ThreadDiffSnapshot> {
    const key = JSON.stringify([request.ownerId, request.threadId, request.workspace]);
    const pending = this.#requests.get(key);

    if (pending) return pending;
    const operation = this.#list(request).finally(() => this.#requests.delete(key));
    this.#requests.set(key, operation);

    return operation;
  }

  async #list(request: ListThreadDiff) {
    const previous = [...this.#snapshots.values()].filter(
      (snapshot) => snapshot.ownerId === request.ownerId && snapshot.threadId === request.threadId,
    );

    if (this.#opening.size >= 4) return create(ThreadDiffSnapshotSchema, { error: Failure.BUSY });
    const evictions: Promise<void>[] = [];

    while (this.#snapshots.size - previous.length + this.#opening.size >= 4) {
      const victim = [...this.#snapshots.values()].find((snapshot) => !previous.includes(snapshot));

      if (!victim) return create(ThreadDiffSnapshotSchema, { error: Failure.BUSY });
      evictions.push(this.#remove(victim.id));
    }

    const opening: Opening = { threadId: request.threadId, controller: new AbortController() };
    this.#opening.add(opening);
    const operation = Promise.all(evictions).then(() => this.#build(request, opening));
    opening.pending = operation.then(
      () => {},
      () => {},
    );

    try {
      return await operation;
    } finally {
      this.#opening.delete(opening);
    }
  }

  async #build(request: ListThreadDiff, opening: Opening) {
    const target = await directoryPath(request.workspace, "");
    const directory = await mkdtemp(join(this.#baseDirectory, "snapshot-"));
    let retained = false;

    try {
      const signal = AbortSignal.any([opening.controller.signal, AbortSignal.timeout(30_000)]);
      const built = await buildDiff(target.root, directory, { bytes: 0, signal });
      signal.throwIfAborted();

      if (!built) return create(ThreadDiffSnapshotSchema, { error: Failure.NOT_REPOSITORY });
      const current = await directoryPath(request.workspace, "");

      if (current.rootIdentity !== target.rootIdentity)
        return create(ThreadDiffSnapshotSchema, { error: Failure.CHANGED });
      // A successful refresh replaces this thread's prior snapshot; failed refreshes preserve it.
      await Promise.all(
        [...this.#snapshots.values()].flatMap((snapshot) =>
          snapshot.ownerId === request.ownerId && snapshot.threadId === request.threadId
            ? [this.#remove(snapshot.id)]
            : [],
        ),
      );
      signal.throwIfAborted();
      const id = crypto.randomUUID();

      const snapshot: Snapshot = {
        id,
        ownerId: request.ownerId,
        threadId: request.threadId,
        workspace: request.workspace,
        rootIdentity: target.rootIdentity,
        directory,
        spools: built.spools,
        timer: setTimeout(() => void this.#remove(id), DIFF_TTL),
      };

      snapshot.timer.unref();
      this.#snapshots.set(id, snapshot);
      retained = true;

      return create(ThreadDiffSnapshotSchema, { snapshotId: id, files: built.files, complete: true });
    } catch (cause) {
      if (
        cause instanceof DiffLimit ||
        cause instanceof ProcessTimeoutError ||
        (cause instanceof Error && ["TimeoutError", "AbortError"].includes(cause.name))
      )
        return create(ThreadDiffSnapshotSchema, { error: Failure.TOO_LARGE });

      if (cause instanceof CommandError && cause.code === "DIFF_CHANGED")
        return create(ThreadDiffSnapshotSchema, { error: Failure.CHANGED });
      throw cause;
    } finally {
      if (!retained) await rm(directory, { recursive: true, force: true });
    }
  }

  async read(request: ReadThreadDiff) {
    if (!validDiffPath(request.path) || request.snapshotId.length > 64 || request.limit > 200) throw diffRefused();

    const page = create(ThreadDiffPageSchema, {
      snapshotId: request.snapshotId,
      path: request.path,
      offset: request.offset,
    });

    const snapshot = this.#snapshots.get(request.snapshotId);

    if (
      !snapshot ||
      snapshot.ownerId !== request.ownerId ||
      snapshot.threadId !== request.threadId ||
      snapshot.workspace !== request.workspace
    ) {
      page.error = Failure.SNAPSHOT_EXPIRED;

      return page;
    }

    const target = await directoryPath(request.workspace, "");

    if (this.#snapshots.get(snapshot.id) !== snapshot) {
      page.error = Failure.SNAPSHOT_EXPIRED;

      return page;
    }

    if (target.rootIdentity !== snapshot.rootIdentity) {
      page.error = Failure.CHANGED;
      await this.#remove(snapshot.id);

      return page;
    }

    const spool = snapshot.spools.get(request.path);

    if (!spool) throw diffRefused();
    page.lineCount = spool.file.lineCount;
    page.lines = readDiffSpool(spool, request.offset, Math.max(1, Math.min(request.limit || 128, 200)));
    this.#snapshots.delete(snapshot.id);
    this.#snapshots.set(snapshot.id, snapshot);

    return page;
  }

  async #remove(id: string) {
    const snapshot = this.#snapshots.get(id);

    if (!snapshot) return;
    this.#snapshots.delete(id);
    clearTimeout(snapshot.timer);
    await rm(snapshot.directory, { recursive: true, force: true });
  }

  async closeThread(threadId: string) {
    const jobs = [...this.#opening].filter((job) => job.threadId === threadId);

    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map((job) => job.pending));
    await Promise.all(
      [...this.#snapshots.values()].flatMap((snapshot) =>
        snapshot.threadId === threadId ? [this.#remove(snapshot.id)] : [],
      ),
    );
  }

  async close() {
    for (const job of this.#opening) job.controller.abort();
    await Promise.all([...this.#opening].map((job) => job.pending));
    await Promise.all([...this.#snapshots.keys()].map((id) => this.#remove(id)));
  }
}
