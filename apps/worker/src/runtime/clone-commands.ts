import type { Command } from "@canopy/contracts";
import { cloneRepository } from "../git/clone.ts";
import { GitError } from "../git/git.ts";
import { CommandError, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

/** Clone lifetimes are transient and independent of thread commands and their journal. */
export class CloneCommands {
  readonly #active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  constructor(readonly ctx: HostContext) {}

  async cloneRepository(
    kind: Extract<Command["kind"], { case: "cloneRepository" }>,
    commandId: string,
  ): Promise<CommandOutput> {
    const abort = new AbortController();
    const done = Promise.withResolvers<void>();
    this.#active.set(commandId, { abort, done: done.promise });

    try {
      return {
        directoryPath: await cloneRepository(kind.value.parentPath, kind.value.name, kind.value.url, {
          ...this.ctx.state.options.cloneTimeouts,
          commandId,
          signal: abort.signal,
          ...(kind.value.reportProgress && {
            progress: (progress) => this.ctx.ops.send({ case: "cloneProgress", value: progress }),
          }),
        }),
      };
    } catch (error) {
      if (error instanceof GitError) throw new CommandError(error.code, error.message, true);
      throw error;
    } finally {
      this.#active.delete(commandId);
      done.resolve();
    }
  }

  async cancelCloneRepository(commandId: string): Promise<CommandOutput> {
    const active = this.#active.get(commandId);
    active?.abort.abort();
    await active?.done;

    return {};
  }

  async closeClones(): Promise<void> {
    for (const active of this.#active.values()) active.abort.abort();
    await Promise.all([...this.#active.values()].map((active) => active.done));
  }
}
