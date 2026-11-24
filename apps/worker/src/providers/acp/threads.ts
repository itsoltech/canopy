import type { ForkSpec, ThreadSpec, UserInput } from "@canopy/contracts";
import { Effect } from "effect";
import { workerDiagnostics } from "../../diagnostics/worker.ts";
import { threadLifecycle } from "../thread-lifecycle.ts";
import type { ModelInit } from "../models.ts";
import { TurnAdmissionCancelled, type TurnSettings } from "../turn-input.ts";
import { sessionSettings, openAcpSession } from "./session.ts";
import type { AcpProvider, AcpThreadOptions, AcpThreadSession } from "./thread-types.ts";
import { runAcpTurn } from "./turn.ts";

/** Owns one ACP process per Canopy thread. Launch settings and approval policy belong to the provider. */
export abstract class AcpThreads<Options extends AcpThreadOptions = AcpThreadOptions> {
  readonly #entries = new Map<string, AcpThreadSession>();
  readonly #preparing = new Map<string, () => Promise<void>>();
  readonly #admissions = new Map<string, string>();
  #closed = false;
  readonly #lifecycle = threadLifecycle((threadId) => new Error(`Thread ${threadId} is being unloaded`));

  constructor(
    readonly options: Options,
    readonly provider: AcpProvider,
  ) {}
  abstract listModels(profileId: string): Promise<{ models: ModelInit[] }>;

  running(threadId: string): boolean {
    return !!this.#entries.get(threadId)?.turnId;
  }
  async create(spec: ThreadSpec, fork?: ForkSpec): Promise<string> {
    if (fork) throw new Error(`${this.provider.name} ACP does not expose session fork`);
    const entry = await this.#open(spec);

    try {
      await this.options.record(spec.threadId, {
        body: { case: "threadReady", value: { providerThreadId: entry.session.sessionId } },
      });

      return entry.session.sessionId;
    } finally {
      this.#idle(spec.threadId, entry);
    }
  }
  #open(spec: ThreadSpec, settings?: TurnSettings): Promise<AcpThreadSession> {
    if (this.#closed) return Promise.reject(new Error(`${this.provider.name} runtime closed`));

    return Effect.runPromise(
      this.#lifecycle.run(spec.threadId, (current) =>
        Effect.tryPromise({
          try: () => this.#prepare(spec, settings, current),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
      ),
    );
  }
  async #prepare(
    spec: ThreadSpec,
    settings: TurnSettings | undefined,
    current: () => boolean,
  ): Promise<AcpThreadSession> {
    if (spec.sandboxProfile) throw new Error(`${this.provider.name} ACP does not support named sandbox profiles.`);

    if ((settings?.serviceTier || spec.serviceTier || "default") !== "default")
      throw new Error(`${this.provider.name} ACP does not support independent speed tiers.`);
    const profile = this.options.profile(spec.providerProfileId);

    if (!profile) throw new Error(`${this.provider.name} provider instance unavailable`);

    const selection = sessionSettings(spec, settings);
    const previous = this.#entries.get(spec.threadId);

    if (previous?.turnId) throw new Error(`${this.provider.name} turn already running`);

    if (previous && spec.providerThreadId && spec.providerThreadId !== previous.session.sessionId)
      throw new Error("Thread refers to a different ACP session");

    if (previous?.settings === selection.key && !previous.client.closed) {
      clearTimeout(previous.idleTimer);

      return previous;
    }

    const sessionId = previous?.session.sessionId || spec.providerThreadId;

    if (previous) {
      if (!previous.client.canRestore) throw new Error(`Installed ${this.provider.name} cannot reopen this session`);
      await previous.dispose();
    }

    if (this.#closed || !current() || settings?.canSubmit?.() === false) throw new TurnAdmissionCancelled();

    try {
      const entry = await openAcpSession(this.provider, this.options, spec, profile, selection, sessionId, (dispose) =>
        this.#preparing.set(spec.threadId, dispose),
      );

      if (this.#closed || !current() || settings?.canSubmit?.() === false) {
        await entry.dispose();
        throw new TurnAdmissionCancelled();
      }

      this.#entries.set(spec.threadId, entry);

      return entry;
    } finally {
      this.#preparing.delete(spec.threadId);
    }
  }
  async startTurn(spec: ThreadSpec, turnId: string, input: UserInput, settings?: TurnSettings): Promise<void> {
    if (settings?.canSubmit?.() === false) return;
    // A reconnect can redeliver StartTurn while preparing, prompting or waiting on a permission card.
    const admitted = this.#admissions.get(spec.threadId);

    if (admitted === turnId) return;

    if (admitted) throw new Error(`${this.provider.name} turn already running`);
    this.#admissions.set(spec.threadId, turnId);

    workerDiagnostics.turns.begin(spec.threadId, turnId, this.provider.kind);
    let entry: AcpThreadSession | undefined;

    try {
      entry = await this.#open(spec, settings);
      await settings?.connectorsReady?.();

      if (this.#entries.get(spec.threadId) !== entry || settings?.canSubmit?.() === false) {
        workerDiagnostics.turns.finish(spec.threadId, turnId, true);

        return;
      }

      entry.turnId = turnId;
      entry.turn = new AbortController();
      entry.toolUses.clear();
      await runAcpTurn(this.provider, this.options, entry, spec, turnId, input, entry.turn.signal, settings);
    } catch (error) {
      workerDiagnostics.turns.finish(spec.threadId, turnId, true);
      throw error;
    } finally {
      this.#admissions.delete(spec.threadId);

      if (entry) {
        entry.turn?.abort();
        entry.turn = undefined;
        entry.turnId = "";
        this.#idle(spec.threadId, entry);
      }
    }
  }
  async interrupt(threadId: string, turnId: string): Promise<void> {
    const entry = this.#entries.get(threadId);

    if (!entry?.turn || entry.turnId !== turnId) throw new Error(`${this.provider.name} turn is not running`);
    entry.turn.abort();
    await entry.client.cancel(entry.session.sessionId);
  }
  async unload(threadId: string): Promise<void> {
    await Effect.runPromise(
      this.#lifecycle.unload(
        threadId,
        Effect.tryPromise({
          try: async () => {
            const entry = this.#entries.get(threadId);
            this.#entries.delete(threadId);
            entry?.turn?.abort();
            await entry?.dispose();
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
        () => {
          void this.#preparing
            .get(threadId)?.()
            .catch(() => {});
        },
      ),
    );
  }
  #idle(threadId: string, entry: AcpThreadSession): void {
    if (this.#entries.get(threadId) !== entry || entry.turnId) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (this.#entries.get(threadId) === entry && !this.#admissions.has(threadId)) void this.unload(threadId);
    }, this.options.idleUnloadMs ?? 900_000);
    entry.idleTimer.unref();
  }
  async close(): Promise<void> {
    this.#closed = true;
    const ids = new Set([...this.#entries.keys(), ...this.#preparing.keys(), ...this.#admissions.keys()]);
    await Promise.all([...ids].map((id) => this.unload(id)));
  }
}
