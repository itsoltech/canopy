import { create, type JsonValue } from "@bufbuild/protobuf";
import { ui, type ThreadSecretReceipt } from "@canopy/contracts";
import type { AgentBusArgs } from "@canopy/domain";
import { Predicate, type ManagedRuntime } from "effect";
import { GatewayStore } from "../store/store.ts";
import type { CallSource } from "../store/agent-bus.ts";
import { toUiThreadSecret, type ThreadSecretRow } from "../store/thread-secrets.ts";
import type { WorkerLink } from "../worker-link/index.ts";
import type { Hub } from "./hub.ts";

export class ThreadSecrets {
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  #stopped = false;
  constructor(
    private readonly options: {
      runtime: ManagedRuntime.ManagedRuntime<GatewayStore, unknown>;
      link: WorkerLink;
      hub: Hub;
      userId: string;
      ttlMs?: number;
    },
  ) {}

  async request(source: CallSource, args: AgentBusArgs["request_secret"]): Promise<JsonValue> {
    const row = await this.options.runtime.runPromise(GatewayStore.use((s) => s.requestSecret(source, args)));
    this.publish(row);
    const deadline = Date.now() + 120_000;

    for (;;) {
      const result = await this.options.runtime.runPromise(
        GatewayStore.use((s) => s.secretResult(source.threadId, row.id)),
      );

      if (Predicate.isObject(result) && result["status"] !== "pending") return result;

      if (this.#stopped || Date.now() >= deadline) return result;
      await Bun.sleep(250);
    }
  }

  async answer(request: ui.AnswerThreadSecretRequest): Promise<ui.ThreadSecret> {
    const row = await this.options.runtime.runPromise(
      GatewayStore.use((s) =>
        s.answerSecret(
          this.options.userId,
          request.requestId,
          request.value,
          request.decline,
          this.options.ttlMs ?? 86_400_000,
        ),
      ),
    );

    this.publish(row);
    await this.syncThread(row.thread_id);

    return toUiThreadSecret(row);
  }

  async revoke(requestId: string): Promise<ui.ThreadSecret> {
    const row = await this.options.runtime.runPromise(
      GatewayStore.use((s) => s.revokeSecret(this.options.userId, requestId)),
    );

    this.publish(row);
    await this.syncThread(row.thread_id);

    return toUiThreadSecret(row);
  }

  async syncThread(threadId: string): Promise<void> {
    const thread = await this.options.runtime.runPromise(GatewayStore.use((s) => s.thread(threadId, true)));

    if (thread.worker_id) await this.sync(thread.worker_id);
  }

  async sync(workerId: string, reset = false): Promise<void> {
    const connection = this.options.link.connections.get(workerId);

    if (!connection?.isOpen || !connection.hello.capabilities.includes("thread_secrets")) return;

    const deliveries = await this.options.runtime.runPromise(
      GatewayStore.use((s) => s.secretDeliveries(workerId, reset)),
    );

    for (const value of deliveries) {
      try {
        connection.send({ case: "threadSecretDelivery", value });
      } catch {
        return;
      } // reconnect retries; never log the envelope or its errors
    }
  }

  receipt(workerId: string, receipt: ThreadSecretReceipt): Promise<void> {
    return this.options.runtime.runPromise(GatewayStore.use((s) => s.secretReceipt(workerId, receipt)));
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;

    try {
      const expired = await this.options.runtime.runPromise(GatewayStore.use((s) => s.expireSecrets()));

      for (const row of expired) this.publish(row);

      for (const workerId of this.options.link.connections.keys()) await this.sync(workerId);
    } finally {
      this.#ticking = false;
    }
  }

  start(): void {
    this.#stopped = false;
    this.#timer ??= setInterval(() => {
      void this.tick().catch(() => {});
    }, 1000);
    this.#timer.unref();
  }
  stop(): void {
    this.#stopped = true;

    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
  private publish(row: ThreadSecretRow): void {
    this.options.hub.publishThread(
      row.thread_id,
      create(ui.ThreadUpdateSchema, { change: { case: "secret", value: toUiThreadSecret(row) } }),
    );
  }
}
