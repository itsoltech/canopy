import { ownerModuleEnabled } from "../store/module-access.ts";
import type { Effect } from "effect";
import { BotStore } from "../bots/store.ts";
import { deliverBotSteer } from "../core/bot-steer.ts";
import type { GatewayCoreOptions } from "../core/core-context.ts";
import type { GatewayCore } from "../core/core.ts";
import { MessengerStore } from "./store.ts";
import { credentialKey, MessengerAccountSession } from "./account-session.ts";
import type { SteerInput } from "./types.ts";

/** Socket reception and durable buffers run independently of model inference. */
export class MessengerRuntime {
  readonly owner: string;
  readonly #accounts = new Map<string, MessengerAccountSession>();
  readonly #steers = new Set<Promise<void>>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #refreshAt = 0;
  #stopped = true;
  #configured = false;

  constructor(
    readonly core: GatewayCore,
    readonly options: GatewayCoreOptions,
  ) {
    this.owner = options.userId;
  }

  run<A, E>(use: (store: MessengerStore["Service"]) => Effect.Effect<A, E>): Promise<A> {
    return this.options.runtime.runPromise(MessengerStore.use(use));
  }

  enabled(): Promise<boolean> {
    return this.options.runtime.runPromise(ownerModuleEnabled(this.owner, "bots"));
  }

  now(): Date {
    return this.options.botClock?.() ?? new Date();
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#timer = setInterval(() => this.wake(false), 250);
    this.#timer.unref();
    this.wake();
  }

  wake(refresh = true): void {
    if (refresh) this.#refreshAt = 0;

    if (this.#stopped || this.#running) return;
    this.#running = this.tick()
      .catch(() => {
        this.options.log?.("messengers: queue processing will retry");
      })
      .finally(() => {
        this.#running = undefined;
      });
  }

  async tick(): Promise<void> {
    if (this.#stopped) return;
    const now = this.now();

    if (now.getTime() >= this.#refreshAt) {
      this.#refreshAt = now.getTime() + 5000;
      await this.#refresh();
    }

    if (this.#stopped || !this.#configured) return;
    const steers = await this.run((s) => s.dispatch(this.owner, now));

    for (const input of steers) {
      const task = this.#steer(input)
        .catch(() => {
          // A lost response is not evidence that a harness missed the input. Terminal reconciliation
          // retains unconfirmed text for a follow-up, without replaying this transient command.
          this.options.log?.("messengers: live update delivery is unconfirmed");
        })
        .finally(() => {
          this.#steers.delete(task);
        });

      this.#steers.add(task);
    }

    for (const session of this.#accounts.values()) session.pump();
    await this.core.bots.tick();
  }

  async #refresh(): Promise<void> {
    const accounts = (await this.enabled()) ? await this.run((s) => s.accounts(this.owner)) : [];

    const enabled = new Map(
      accounts
        .filter((a) => a.enabled && !["needs_authorization", "needs_reconnect"].includes(a.status))
        .map((a) => [a.id, a]),
    );

    this.#configured = enabled.size > 0;

    for (const [id, session] of this.#accounts) {
      const account = enabled.get(id);
      const credentials = account ? await this.#credentials(id) : undefined;
      const renewed = account && (await this.run((s) => s.renewAccount(this.owner, session.lease, this.now())));

      if (!credentials || credentialKey(credentials) !== session.signature || !renewed) {
        this.#accounts.delete(id);
        await session.close();
      }
    }

    for (const account of enabled.values()) {
      if (this.#accounts.has(account.id) || this.#stopped) continue;
      const credentials = await this.#credentials(account.id);

      if (!credentials) continue;
      const lease = await this.run((s) => s.claimAccount(this.owner, account.id, this.options.instanceId, this.now()));

      if (!lease) continue;
      this.#accounts.set(account.id, new MessengerAccountSession(this, account, lease, credentials));
    }
  }

  async #credentials(id: string) {
    try {
      return await this.run((s) => s.credentials(this.owner, id, this.options.messengerTransport));
    } catch {
      // One revoked or unavailable connection must not block reception for other accounts.
      this.options.log?.("messengers: account credentials unavailable");

      return undefined;
    }
  }

  async #steer(input: SteerInput): Promise<void> {
    const job = await this.options.runtime.runPromise(BotStore.use((s) => s.harnessTurn(input.turnId)));

    const accepted =
      job?.outcome === null &&
      (await deliverBotSteer(this.core, {
        workerId: job.worker_id,
        botId: input.botId,
        turnId: input.turnId,
        inputId: input.id,
        text: input.text,
      }));

    if (!accepted) await this.run((s) => s.settleSteer(this.owner, input.id, false));
  }

  async stop(): Promise<void> {
    this.#stopped = true;

    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
    await Promise.allSettled([...this.#accounts.values()].map((session) => session.close()));
    this.#accounts.clear();
    await Promise.allSettled(this.#steers);
  }
}
