import { create, type JsonValue } from "@bufbuild/protobuf";
import { ui, type ThreadSecretDelivery, type ThreadSecretReceipt } from "@canopy/contracts";
import { PROJECT_SECRET_LEASES, type AgentBusArgs } from "@canopy/domain";
import { PROJECT_LOGINS } from "@canopy/domain/project-logins";
import { Predicate, type ManagedRuntime } from "effect";
import { GatewayStore, Invalid } from "../store/store.ts";
import type { CallSource } from "../store/agent-bus.ts";
import { toUiLoginDecision, toUiProjectSecretLease, toUiThreadSecret } from "../store/thread-secrets.ts";
import { decisionResult, type LoginLeaseOpened } from "../store/project-login-leases.ts";
import type { WorkerConnection, WorkerLink } from "../worker-link/index.ts";
import type { Hub } from "./hub.ts";

// The worker gives the entire project request ten seconds, including both transport hops.
const PROJECT_SECRET_WAIT_MS = 8_000;

// A login that asks each time waits for the owner, within the harnesses' MCP tool timeouts (60 s); the browser
// tool then asks the agent to call again.
export const PROJECT_LOGIN_WAIT_MS = 45_000;

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
      /** Whether the browser action `authorization` that asked for a login still runs on `connection`. */
      loginAdmitted: (
        connection: WorkerConnection,
        scope: { threadId: string; turnId: string },
        authorization: string,
        name: string,
      ) => boolean;
    },
  ) {}

  async request(
    source: CallSource,
    args: AgentBusArgs["request_secret"],
    connection?: WorkerConnection,
  ): Promise<JsonValue> {
    if (args.project_secret) return this.requestProjectLease(source, args.project_secret, connection, args.request_id);

    const row = await this.options.runtime.runPromise(GatewayStore.use((s) => s.requestSecret(source, args)));
    this.publish(toUiThreadSecret(row));

    return this.waitForFile(() =>
      this.options.runtime.runPromise(GatewayStore.use((s) => s.secretResult(source.threadId, row.id))),
    );
  }

  private async requestProjectLease(source: CallSource, name: string, connection?: WorkerConnection, retryId?: string) {
    if (!connection?.hello.capabilities.includes(PROJECT_SECRET_LEASES))
      throw new Invalid("This worker does not support project secret leases on the current connection.");

    const deadline = performance.now() + PROJECT_SECRET_WAIT_MS;
    const pending = { request_id: retryId ?? source.callId, status: "pending", delivery: "waiting_for_worker" };
    const worker = this.projectWorker(connection);

    if (!worker) return pending;
    const { runtime, userId } = this.options;

    const open = () =>
      runtime.runPromise(
        GatewayStore.use((s) =>
          s.openProjectSecretLease(
            userId,
            worker,
            source,
            name,
            retryId,
            connection.hello.capabilities.includes(PROJECT_LOGINS),
          ),
        ),
      );

    const opened = await this.waitForDecision(source, await open(), deadline, open);

    if (!opened) return pending;

    if ("decision" in opened)
      return {
        ...decisionResult(opened.decision),
        ...(opened.decision.status === "pending" && {
          instructions: `Waiting for the owner to allow file access to login ${name} in Canopy. Call request_secret again with the same project_secret once they answer.`,
        }),
      };
    await this.syncProjectLeases(connection);

    return this.waitForFile(
      () =>
        runtime.runPromise(
          GatewayStore.use((s) => s.projectSecretLeaseResult(userId, worker, source, opened.lease, name)),
        ),
      deadline,
      connection,
    );
  }

  /** Agent Browser asks for a login on one website. The value reaches only the worker's memory. */
  async leaseLogin(
    source: CallSource,
    name: string,
    origin: string,
    connection: WorkerConnection,
    authorization: { id: string; live: () => boolean },
  ) {
    const authorized = authorization.live;

    if (!connection.hello.capabilities.includes(PROJECT_LOGINS))
      throw new Invalid("This worker does not support project logins.");

    const deadline = performance.now() + PROJECT_LOGIN_WAIT_MS;
    const worker = this.projectWorker(connection);
    const pending = { request_id: source.callId, status: "pending", delivery: "waiting_for_worker" };

    if (!worker) return pending;
    const { runtime, userId } = this.options;

    // The browser action can end while the owner decides: its answer then waits for the next action.
    const open = async () =>
      authorized()
        ? runtime.runPromise(
            GatewayStore.use((s) => s.openProjectLoginLease(userId, worker, source, name, origin, authorization.id)),
          )
        : undefined;

    const opened = await this.waitForDecision(source, await open(), deadline, open);

    if (!opened || !authorized())
      return authorized() ? pending : { request_id: source.callId, status: "expired", reason: "action_ended" };

    if ("decision" in opened) return decisionResult(opened.decision);
    await this.syncProjectLeases(connection);

    return this.waitForFile(
      () =>
        runtime.runPromise(
          GatewayStore.use((s) => s.projectLoginLeaseResult(userId, worker, source, opened.lease, name)),
        ),
      deadline,
      connection,
    );
  }

  /** A login that asks each time waits for the owner's answer for the turn, then opens the lease. */
  private async waitForDecision(
    source: CallSource,
    opened: LoginLeaseOpened | undefined,
    deadline: number,
    open: () => Promise<LoginLeaseOpened | undefined>,
  ): Promise<LoginLeaseOpened | undefined> {
    if (!opened || !("decision" in opened) || opened.decision.status !== "pending") return opened;
    this.refresh();
    const { runtime, userId } = this.options;

    for (;;) {
      const remaining = deadline - performance.now();

      if (this.#stopped || remaining <= 0) return opened;
      await Bun.sleep(Math.min(250, remaining));

      const decision = await runtime.runPromise(
        GatewayStore.use((s) => s.projectLoginDecision(userId, source.threadId, opened.decision.id)),
      );

      if (!decision) return opened;

      if (decision.status !== "pending") return decision.status === "allowed" ? open() : { decision };
    }
  }

  private async waitForFile(
    resultOf: () => Promise<JsonValue>,
    deadline = performance.now() + 120_000,
    connection?: WorkerConnection,
  ): Promise<JsonValue> {
    for (;;) {
      const result = await resultOf();

      if (Predicate.isObject(result) && result["status"] !== "pending") return result;

      const remaining = deadline - performance.now();

      if (this.#stopped || remaining <= 0 || (connection && !this.projectWorker(connection))) return result;
      await Bun.sleep(Math.min(250, remaining));
    }
  }

  async answer(request: ui.AnswerThreadSecretRequest): Promise<ui.ThreadSecret> {
    const login = await this.options.runtime.runPromise(
      GatewayStore.use((s) => s.answerProjectLoginDecision(this.options.userId, request.requestId, request.decline)),
    );

    if (login) {
      this.refresh();

      return toUiLoginDecision(login);
    }

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

    this.publish(toUiThreadSecret(row));
    await this.syncThread(row.thread_id);

    return toUiThreadSecret(row);
  }

  async revoke(requestId: string): Promise<ui.ThreadSecret> {
    const login = await this.options.runtime.runPromise(
      GatewayStore.use((s) => s.revokeProjectLoginDecision(this.options.userId, requestId)),
    );

    if (login) {
      this.refresh();

      return toUiLoginDecision(login);
    }

    const lease = await this.options.runtime.runPromise(
      GatewayStore.use((s) => s.revokeProjectSecretLease(this.options.userId, requestId)),
    );

    if (lease) {
      this.refresh();

      return toUiProjectSecretLease(lease);
    }

    const row = await this.options.runtime.runPromise(
      GatewayStore.use((s) => s.revokeSecret(this.options.userId, requestId)),
    );

    this.publish(toUiThreadSecret(row));
    await this.syncThread(row.thread_id);

    return toUiThreadSecret(row);
  }

  async syncThread(threadId: string): Promise<void> {
    const thread = await this.options.runtime.runPromise(GatewayStore.use((s) => s.thread(threadId, true)));

    if (thread.worker_id) await this.sync(thread.worker_id);
  }

  async sync(workerId: string, reset = false): Promise<void> {
    const connection = this.options.link.connections.get(workerId);

    if (!connection?.isOpen) return;

    if (connection.hello.capabilities.includes("thread_secrets")) await this.syncManualSecrets(connection, reset);
    await this.syncProjectLeases(connection);
  }

  private async syncManualSecrets(connection: WorkerConnection, reset: boolean) {
    const deliveries = await this.options.runtime.runPromise(
      GatewayStore.use((s) => s.secretDeliveries(connection.workerId, reset)),
    );

    for (const value of deliveries) {
      try {
        connection.send({ case: "threadSecretDelivery", value });
      } catch {
        return;
      } // reconnect retries; never log the envelope or its errors
    }
  }

  private projectWorker(connection?: WorkerConnection) {
    if (
      !connection?.isOpen ||
      !connection.projectSecretLeasesReady ||
      connection.registrationEpoch === undefined ||
      this.options.link.connections.get(connection.workerId) !== connection ||
      !connection.hello.capabilities.includes(PROJECT_SECRET_LEASES)
    )
      return;

    return { workerId: connection.workerId, epoch: connection.registrationEpoch };
  }

  async syncProjectLeases(connection: WorkerConnection) {
    const worker = this.projectWorker(connection);

    if (!worker) return;
    const { runtime, userId } = this.options;

    await runtime.runPromise(
      GatewayStore.use((s) =>
        s.deliverProjectSecretLeases(userId, worker, (value) => {
          if (!this.projectWorker(connection)) return false;

          try {
            connection.send({ case: "threadSecretDelivery", value });

            return true;
          } catch {
            return false;
          }
        }),
      ),
    );
  }

  async projectSecretDeliveryValue(connection: WorkerConnection, delivery: ThreadSecretDelivery) {
    const worker = this.projectWorker(connection);

    if (!worker) return;
    const { runtime, userId } = this.options;

    return runtime
      .runPromise(
        GatewayStore.use((s) =>
          s.projectSecretDeliveryValue(userId, worker, delivery, (authorization, name) =>
            this.options.loginAdmitted(connection, delivery, authorization, name),
          ),
        ),
      )
      .catch(() => undefined);
  }

  async receipt(connection: WorkerConnection, receipt: ThreadSecretReceipt): Promise<void> {
    const { runtime, userId } = this.options;

    if (receipt.turnId) {
      const worker = this.projectWorker(connection);

      if (worker)
        await runtime.runPromise(GatewayStore.use((s) => s.receiptProjectSecretLease(userId, worker, receipt)));
    } else if (!receipt.rejected) {
      await runtime.runPromise(GatewayStore.use((s) => s.secretReceipt(connection.workerId, receipt)));
    }
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;

    try {
      const { runtime, userId } = this.options;
      const expired = await runtime.runPromise(GatewayStore.use((s) => s.expireSecrets(userId)));

      for (const row of expired) this.publish(toUiThreadSecret(row));
      await runtime.runPromise(GatewayStore.use((s) => s.expireProjectSecretLeases(userId)));
      const leases = await runtime.runPromise(GatewayStore.use((s) => s.projectSecretLeaseUpdates(userId)));

      for (const lease of leases) if (!lease.login) this.publish(toUiProjectSecretLease(lease));
      const decisions = await runtime.runPromise(GatewayStore.use((s) => s.projectLoginDecisionUpdates(userId)));

      for (const decision of decisions) this.publish(toUiLoginDecision(decision));

      for (const workerId of this.options.link.connections.keys()) await this.sync(workerId);
    } finally {
      this.#ticking = false;
    }
  }

  refresh() {
    if (!this.#stopped) void this.tick().catch(() => {});
  }

  start(): void {
    this.#stopped = false;
    this.#timer ??= setInterval(() => {
      this.refresh();
    }, 1000);
    this.#timer.unref();
  }
  stop(): void {
    this.#stopped = true;

    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
  private publish(secret: ui.ThreadSecret): void {
    this.options.hub.publishThread(
      secret.threadId,
      create(ui.ThreadUpdateSchema, { change: { case: "secret", value: secret } }),
    );
  }
}
