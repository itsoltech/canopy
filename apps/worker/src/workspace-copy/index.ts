import { create } from "@bufbuild/protobuf";
import { WorkspaceCopyResultSchema, type WorkspaceCopyOperation } from "@canopy/contracts";
import { CopySources } from "./source.ts";
import { CopyTargets } from "./target.ts";
import { copyError } from "./safety.ts";
import { CommandError } from "../runtime/host-types.ts";

/** File bytes never pass through the worker journal, provider runtimes or diagnostics. */
export class WorkspaceCopies {
  readonly source = new CopySources();
  readonly target: CopyTargets;
  #targetTail: Promise<void> = Promise.resolve();
  readonly #reads = new Set<string>();
  constructor(dataDir: string) {
    this.target = new CopyTargets(dataDir);
  }

  async close() {
    await this.#targetTail;
    await this.target.close();
  }

  async execute(operation: WorkspaceCopyOperation) {
    const action = operation.action;

    if (["prepare", "write", "finish", "cancel"].includes(action.case ?? "")) {
      const prior = this.#targetTail;
      let release = () => {};

      this.#targetTail = new Promise<void>((done) => {
        release = done;
      });
      await prior;

      try {
        return await this.perform(operation);
      } finally {
        release();
      }
    }

    if (action.case !== "read") return this.perform(operation);
    const token = action.value.token;

    if (this.#reads.has(token)) throw copyError("A read is already in progress. Retry the copy.");
    this.#reads.add(token);

    try {
      return await this.perform(operation);
    } finally {
      this.#reads.delete(token);
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
        case "prepare":
          return create(WorkspaceCopyResultSchema, { directory: await this.target.prepare(action.value) });
        case "write":
          await this.target.write(action.value);
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
