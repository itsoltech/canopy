import { clone } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { ItemSchema, ItemStatus, type Item } from "@canopy/contracts";
import { Cause, Effect, Exit, Predicate } from "effect";
import { isHarness } from "@canopy/domain/harnesses";
import { classifyFailure } from "@canopy/domain";
import { Journal } from "../journal/index.ts";
import type { AcpThreads } from "../providers/acp/threads.ts";
import type { AcpThreadOptions } from "../providers/acp/thread-types.ts";
import { AntigravityThreads } from "../providers/antigravity/threads.ts";
import { GrokThreads } from "../providers/grok/threads.ts";
import { providersOf, type ResolvedProfile } from "../providers/profiles.ts";
import type { AppliedConfig } from "../config/remote.ts";
import { CommandError, type AcpHarness } from "./host-types.ts";
import {
  instanceKey,
  matchingProfile,
  runtimeBusy,
  runtimeKeys,
  stopRuntime,
  wantedRuntimes,
} from "./instance-runtimes.ts";
import type { HostContext } from "./host-context.ts";

export class ProviderRuntimes {
  constructor(readonly ctx: HostContext) {}
  async runAcp<A>(instance: string, use: (threads: AcpThreads) => Promise<A>, current = false): Promise<A> {
    return this.useRuntime(instance, current, async () => {
      const handle = this.ctx.state.acp.get(instance);

      if (!handle) throw new CommandError("PROVIDER_UNAVAILABLE", "Provider instance unavailable", true);

      return use(handle.runtime);
    });
  }

  async startAcp(harness: AcpHarness, profile: ResolvedProfile, key: string, config: AppliedConfig): Promise<void> {
    const provider = config[harness];
    const executable = profile.runtime.executablePath || provider.executable;

    if (!executable) return;
    const { state, ops } = this.ctx;

    const options: AcpThreadOptions = {
      dataDir: state.options.dataDir,
      executable,
      linkDeviceLogin: provider.linkDeviceLogin,
      idleUnloadMs: config.limits.idleUnloadSeconds * 1000,
      profile: (id) => matchingProfile(profile, id),
      record: async (threadId, init) => {
        const event = await state.options.runtime.runPromise(
          Journal.use((journal) => state.previews.record(init, (entry) => journal.append(threadId, entry))),
        );

        ops.publish(event);

        return event;
      },
      interact: (request, signal) => ops.interact(request, signal),
      callTool: ops.callTool,
      viewImage: (threadId, cwd, path) => ops.viewImage(threadId, cwd, path),
      localMcpServers: (tools, threadId, defaults) => state.agentTools.localMcpServers(tools, threadId, defaults),
    };

    const start = {
      grok: () => new GrokThreads({ ...options, pricing: state.xaiPricing }),
      antigravity: () =>
        new AntigravityThreads({
          ...options,
          deviceHome: state.deviceHomes.antigravity,
          pricing: state.antigravityPricing,
        }),
    } satisfies Record<AcpHarness, () => AcpThreads>;

    state.acp.set(`${harness}/${profile.id}`, { key, runtime: start[harness]() });
  }

  async runIn<A, E>(effect: Effect.Effect<A, E, Journal>): Promise<A> {
    const exit = await this.ctx.state.options.runtime.runPromiseExit(effect);

    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.squash(exit.cause);

    if (error instanceof CommandError) throw error;

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

  /** Serialize swaps and acquisitions. Never wait for a turn inside this lock. */
  #locked<A>(run: () => Promise<A>): Promise<A> {
    const next = this.ctx.state.runtimeReconcile.then(run);
    this.ctx.state.runtimeReconcile = next.then(
      () => {},
      () => {},
    );

    return next;
  }

  wakeRuntimes(): void {
    for (const wake of this.ctx.state.runtimeWaiters) wake();
    this.ctx.state.runtimeWaiters.clear();
  }

  /** New work waits for its instance to drain; controls continue to address the running snapshot. */
  async useRuntime<A>(key: string, current: boolean, use: () => Promise<A>): Promise<A> {
    for (;;) {
      let wake!: () => void;

      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });

      this.ctx.state.runtimeWaiters.add(wake);

      const acquired = await this.#locked(async () => {
        if (this.ctx.state.closing || this.ctx.state.shuttingDown)
          throw new CommandError("WORKER_DRAINING", "worker is stopping", false);

        if (!current) await this.#reconcile(key);
        const wanted = wantedRuntimes(this.ctx).get(key);
        const active = runtimeKeys(this.ctx).get(key);

        if (!active || (!current && !wanted)) {
          const harness = key.split("/")[0];
          const config = this.ctx.state.config;

          const instance = config?.profiles.find(({ config: profile }) =>
            providersOf(profile).some((provider) => instanceKey(provider, profile.id) === key),
          );

          const problem = instance?.problem ?? (harness && isHarness(harness) ? config?.[harness].problem : undefined);

          throw new CommandError("PROVIDER_UNAVAILABLE", problem ?? "provider instance unavailable", true);
        }

        if (!current && active !== wanted?.key) return false;
        this.ctx.state.runtimeUsers.set(key, (this.ctx.state.runtimeUsers.get(key) ?? 0) + 1);

        return true;
      }).catch((error) => {
        this.ctx.state.runtimeWaiters.delete(wake);
        throw error;
      });

      if (!acquired) {
        await changed;
        continue;
      }

      this.ctx.state.runtimeWaiters.delete(wake);

      try {
        return await use();
      } finally {
        this.ctx.state.runtimeUsers.set(key, (this.ctx.state.runtimeUsers.get(key) ?? 1) - 1);
        this.wakeRuntimes();
        void this.reconcileRuntimes().catch(() => {});
      }
    }
  }

  async reconcileRuntimes(): Promise<void> {
    try {
      await this.#locked(() => this.#reconcile());
    } finally {
      // A save can also revert to the active snapshot or disable an instance while work is waiting.
      this.wakeRuntimes();
    }
  }

  async #reconcile(requestedKey?: string): Promise<void> {
    if (this.ctx.state.closing || this.ctx.state.shuttingDown) return;
    const wanted = wantedRuntimes(this.ctx);
    const active = runtimeKeys(this.ctx);
    let changed = false;
    let startupError: CommandError | undefined;

    for (const key of new Set([...active.keys(), ...wanted.keys()])) {
      const next = wanted.get(key);

      if (active.get(key) === next?.key) {
        this.ctx.state.staleRuntimes.delete(key);
        continue;
      }

      if (runtimeBusy(this.ctx, key)) {
        this.ctx.state.staleRuntimes.add(key);
        continue;
      }

      this.ctx.state.staleRuntimes.delete(key);
      await stopRuntime(this.ctx, key);

      if (next)
        await next.start().catch((error: Error) => {
          // A failed instance must not disconnect WorkerLink or block other providers and bot commands.
          if (key === requestedKey && error instanceof CommandError) startupError = error;
          this.ctx.ops.log(`provider runtime unavailable (${classifyFailure(error.message)})`);
        });
      changed = true;
    }

    if (changed) this.wakeRuntimes();

    if (startupError) throw startupError;
  }

  stopReason(): string {
    return this.ctx.state.shuttingDown ? "worker_shutdown" : "worker_restart";
  }

  async closeOrphans(match: (threadId: string, item: Item) => boolean, stopReason: string): Promise<number> {
    const open = await this.ctx.state.options.runtime.runPromise(Journal.use((j) => j.openBackgroundTasks()));
    let closed = 0;

    for (const { threadId, item } of open) {
      if (!match(threadId, item) || item.content.case !== "backgroundTask") continue;
      const ended = clone(ItemSchema, item);
      ended.status = ItemStatus.INTERRUPTED;

      if (ended.content.case === "backgroundTask") {
        ended.content.value.stopReason = stopReason;
        ended.content.value.endedAt = timestampNow();
      }

      const event = await this.ctx.state.options.runtime.runPromise(
        Journal.use((j) => j.append(threadId, { body: { case: "itemCompleted", value: { item: ended } } })),
      );

      this.ctx.state.secrets.trackProjectBackground(threadId, "", item.itemId, false);
      this.ctx.ops.sendEvent(event);
      closed++;
    }

    return closed;
  }
}
