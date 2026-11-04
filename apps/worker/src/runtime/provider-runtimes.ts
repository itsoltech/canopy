import { clone } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { ItemSchema, ItemStatus, type Item } from "@canopy/contracts";
import { Cause, Effect, Exit, Predicate } from "effect";
import { Journal } from "../journal/index.ts";
import { GrokThreads } from "../providers/grok/threads.ts";

import { CommandError, usableBy, type CodexGroup } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

export class ProviderRuntimes {
  constructor(readonly ctx: HostContext) {}
  async runGrok<A>(use: (threads: GrokThreads) => Promise<A>): Promise<A> {
    if (!this.ctx.state.grok)
      throw new CommandError("PROVIDER_UNAVAILABLE", this.ctx.state.config?.grok.problem ?? "Grok is disabled", false);

    return use(this.ctx.state.grok.runtime);
  }

  async runIn<A, E>(effect: Effect.Effect<A, E, Journal>): Promise<A> {
    const exit = await this.ctx.state.options.runtime.runPromiseExit(effect);

    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.squash(exit.cause);

    if (error instanceof CommandError) throw error;

    // The harness itself refused or failed (e.g. Codex answered the request with an error): the gateway says so.
    const code =
      Predicate.isObject(error) && "harness" in error && error["harness"] === true ? "HARNESS_ERROR" : "THREAD_ERROR";

    throw new CommandError(
      code,
      error instanceof Error || (Predicate.isObject(error) && "message" in error)
        ? String(error.message)
        : String(error),
      true,
    );
  }

  /** Provider runtimes follow the configuration, but are never rebuilt under a running turn. */
  async reconcileRuntimes(): Promise<void> {
    const config = this.ctx.state.config;
    const codexGroups = config ? this.ctx.ops.codexGroups(config) : new Map<string, CodexGroup>();
    const claudeKey = config ? this.ctx.ops.claudeKey(config) : undefined;

    const grokKey =
      config?.grok.enabled && config.grok.executable
        ? JSON.stringify({ grok: config.grok, profiles: config.profiles })
        : undefined;

    const codexChanged =
      codexGroups.size !== this.ctx.state.codex.size ||
      [...codexGroups].some(([name, group]) => this.ctx.state.codex.get(name)?.key !== group.key);

    if (!codexChanged && claudeKey === this.ctx.state.claude?.key && grokKey === this.ctx.state.grok?.key) return;

    if (this.ctx.state.shuttingDown) return;

    if (this.ctx.state.running.size > 0) {
      this.ctx.state.rebuildWanted = true;
      this.ctx.ops.log(
        `provider settings changed; restart deferred until ${this.ctx.state.running.size} running turn(s) finish`,
      );

      return;
    }

    this.ctx.state.rebuildWanted = false;

    if (codexChanged) {
      // Only the processes whose settings changed restart; their threads resume in the new ones.
      for (const name of Array.from(this.ctx.state.codex.keys())) {
        if (this.ctx.state.codex.get(name)?.key !== codexGroups.get(name)?.key) await this.ctx.ops.stopCodex(name);
      }

      await this.ctx.ops.closeCodexOrphans();

      for (const [name, group] of codexGroups)
        if (!this.ctx.state.codex.has(name)) await this.ctx.ops.startCodex(name, group);
    }

    if (claudeKey !== this.ctx.state.claude?.key) await this.ctx.ops.reconcileClaude(config, claudeKey);

    if (grokKey !== this.ctx.state.grok?.key) {
      await this.ctx.state.grok?.runtime.close();
      this.ctx.state.grok = undefined;

      if (grokKey && config?.grok.executable)
        this.ctx.state.grok = {
          key: grokKey,
          runtime: new GrokThreads({
            dataDir: this.ctx.state.options.dataDir,
            executable: config.grok.executable,
            linkDeviceLogin: config.grok.linkDeviceLogin,
            idleUnloadMs: config.limits.idleUnloadSeconds * 1000,
            profile: (id) =>
              this.ctx.state.config?.profiles.find(
                (p) => p.resolved?.id === (id || "native") && usableBy(p.resolved, "grok"),
              )?.resolved,
            record: async (threadId, init) => {
              const enriched = await this.ctx.state.previews.enrich(init);

              const event = await this.ctx.state.options.runtime.runPromise(
                Journal.use((j) => j.append(threadId, enriched)),
              );

              this.ctx.ops.publish(event);

              return event;
            },
            interact: (request, signal) => this.ctx.ops.interact(request, signal),
            callTool: (call) => this.ctx.ops.callTool(call),
            viewImage: (threadId, cwd, path) => this.ctx.ops.viewImage(threadId, cwd, path),
          }),
        };
    }
  }

  /** Why tasks of a stopping provider runtime end: the worker stops, or only the runtime restarts. */
  stopReason(): string {
    return this.ctx.state.shuttingDown ? "worker_shutdown" : "worker_restart";
  }

  /** Ends background tasks the journal has open but no provider process runs any more. */
  async closeOrphans(match: (threadId: string, item: Item) => boolean, stopReason: string): Promise<number> {
    const open = await this.ctx.state.options.runtime.runPromise(Journal.use((j) => j.openBackgroundTasks()));
    let closed = 0;

    for (const { threadId, item } of open) {
      if (!match(threadId, item) || item.content.case !== "backgroundTask") continue;
      const ended = clone(ItemSchema, item);
      ended.status = ItemStatus.INTERRUPTED;

      if (ended.content.case === "backgroundTask") {
        ended.content.value.stopReason = stopReason;
        // Now: when its end is recorded (for a crash, when the worker found it dead).
        ended.content.value.endedAt = timestampNow();
      }

      const event = await this.ctx.state.options.runtime.runPromise(
        Journal.use((j) => j.append(threadId, { body: { case: "itemCompleted", value: { item: ended } } })),
      );

      this.ctx.ops.sendEvent(event);
      closed++;
    }

    return closed;
  }
}
