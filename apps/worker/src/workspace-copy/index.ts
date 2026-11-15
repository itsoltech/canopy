import { create } from "@bufbuild/protobuf";
import { WorkspaceCopyResultSchema, type WorkspaceCopyOperation } from "@canopy/contracts";
import { COPY_LANES } from "@canopy/domain/workspace-copy";
import { CopySources } from "./source.ts";
import { CopyTargets } from "./target.ts";
import { copyError } from "./safety.ts";
import { CommandError } from "../runtime/host-types.ts";

const EXCLUSIVE = new Set(["prepare", "finish", "cancel"]);
const SHARED = new Set(["write", "writeBatch"]);
const READS = new Set(["read", "readBatch"]);

/** Per transfer: frames run side by side; prepare, finish and cancel wait for them and run alone. */
class TransferLock {
  #shared = 0;
  #exclusive: Promise<void> = Promise.resolve();
  #drained: (() => void) | undefined;

  async shared<A>(run: () => Promise<A>): Promise<A> {
    await this.#exclusive;
    this.#shared++;

    try {
      return await run();
    } finally {
      if (--this.#shared === 0) this.#drained?.();
    }
  }

  async exclusive<A>(run: () => Promise<A>): Promise<A> {
    const prior = this.#exclusive;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#exclusive = prior.then(() => promise);
    await prior;

    if (this.#shared) await new Promise<void>((done) => (this.#drained = done));
    this.#drained = undefined;

    try {
      return await run();
    } finally {
      resolve();
    }
  }

  get idle() {
    return this.#shared === 0;
  }
}

/** File bytes never pass through the worker journal, provider runtimes or diagnostics. */
export class WorkspaceCopies {
  readonly source = new CopySources();
  readonly target: CopyTargets;
  readonly #locks = new Map<string, TransferLock>();
  readonly #reads = new Map<string, number>();
  constructor(dataDir: string) {
    this.target = new CopyTargets(dataDir);
  }

  async close() {
    await Promise.all([...this.#locks.values()].map((lock) => lock.exclusive(async () => {})));
    await this.target.close();
  }

  async execute(operation: WorkspaceCopyOperation) {
    const action = operation.action;
    const kind = action.case ?? "";

    if (EXCLUSIVE.has(kind) || SHARED.has(kind)) {
      const token = tokenOf(operation);
      const lock = this.#locks.get(token) ?? new TransferLock();
      this.#locks.set(token, lock);

      try {
        return EXCLUSIVE.has(kind)
          ? await lock.exclusive(() => this.perform(operation))
          : await lock.shared(() => this.perform(operation));
      } finally {
        if (lock.idle && (kind === "cancel" || kind === "finish")) this.#locks.delete(token);
      }
    }

    if (!READS.has(kind)) return this.perform(operation);
    const token = tokenOf(operation);
    const reading = this.#reads.get(token) ?? 0;

    // One read per gateway lane; more means a confused or hostile caller.
    if (reading >= COPY_LANES * 2) throw copyError("Too many reads are in progress. Retry the copy.");
    this.#reads.set(token, reading + 1);

    try {
      return await this.perform(operation);
    } finally {
      const left = (this.#reads.get(token) ?? 1) - 1;

      if (left) this.#reads.set(token, left);
      else this.#reads.delete(token);
    }
  }

  async perform(operation: WorkspaceCopyOperation) {
    const action = operation.action;

    try {
      switch (action.case) {
        case "scan":
          return create(WorkspaceCopyResultSchema, { manifest: await this.source.scan(action.value.rootPath) });
        case "read":
          return create(WorkspaceCopyResultSchema, { chunk: await this.source.read(action.value) });
        case "readBatch":
          return create(WorkspaceCopyResultSchema, { batch: await this.source.readBatch(action.value) });
        case "authorize":
          this.source.authorize(action.value);
          break;
        case "prepare":
          return create(WorkspaceCopyResultSchema, await this.target.prepare(action.value));
        case "write":
          await this.target.write(action.value);
          break;
        case "writeBatch":
          await this.target.writeBatch(action.value);
          break;
        case "finish":
          return create(WorkspaceCopyResultSchema, { directory: await this.target.finish(action.value) });
        case "cancel":
          await this.target.cancel(action.value);
          break;
        case "release":
          this.source.release(action.value);
          break;
        default:
          throw copyError("Choose a copy operation.");
      }

      return create(WorkspaceCopyResultSchema);
    } catch (error) {
      // Filesystem and Git diagnostics can contain local credentials or private paths.
      // Known safe messages are passed through by the caller; all other errors are replaced here.
      if (error instanceof CommandError) throw error;
      throw copyError("Workspace copy failed. Refresh the file list and retry, or choose another destination.");
    }
  }
}

function tokenOf(operation: WorkspaceCopyOperation): string {
  const action = operation.action;

  switch (action.case) {
    case "cancel":
    case "release":
      return action.value;
    case "scan":
    case undefined:
      return "";
    default:
      return action.value.token;
  }
}
