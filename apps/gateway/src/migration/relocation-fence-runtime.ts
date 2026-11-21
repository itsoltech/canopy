import { isMessage, type DescMethod, type Message } from "@bufbuild/protobuf";
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { computerLink as link, ui, update, WorkerLinkService } from "@canopy/contracts";
import { PgClient } from "@effect/sql-pg";
import { Effect, Exit, Redacted, Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import { databaseUrl } from "../database-credentials.ts";
import {
  relocationIdle,
  relocationOperatorLock,
  relocationRuntimeLock,
  relocationShutdownLock,
  relocationTable,
} from "./relocation-fence.ts";

const finishWork = new Set([
  "AnswerBotApproval",
  "AnswerInteraction",
  "AnswerThreadSecret",
  "InterruptBot",
  "InterruptThread",
  "StopBackgroundTask",
]);

const workStreams = new Set(["CloneProject", "CopyWorkspace", "CreateThreadWithProgress", "WorkerSsh"]);

const finishLinkedWork = new Set<DescMethod>([
  link.ComputerMoveService.method.decideMove,
  link.ComputerMoveService.method.moveOutcome,
  link.ThreadMirrorService.method.ackThreadRange,
]);

const finishAgentWork = new Set(["answer", "interrupt_thread"]);

export class StartupFenced extends Error {}

/** This connection holds a session lock until the services and their database pool have shut down. */
export class RelocationRuntime {
  #closing = false;
  #ready = false;
  #operationId: string | undefined;
  #requests = 0;
  #session: { scope: Scope.Closeable; client: Promise<PgClient.PgClient> } | undefined;

  private constructor(private readonly url: string) {}

  static async open(env: NodeJS.ProcessEnv) {
    const relocation = new RelocationRuntime(databaseUrl(env));

    try {
      await relocation.client(true);
      relocation.#ready = true;

      return relocation;
    } catch (error) {
      await relocation.close();
      throw error;
    }
  }

  private async connect(scope: Scope.Closeable, startup: boolean) {
    const sql = await Effect.runPromise(
      PgClient.makeClient({
        url: Redacted.make(this.url),
        applicationName: "canopy-gateway-relocation-guard",
        connectTimeout: "5 seconds",
        startupParameters: { statement_timeout: "5s" },
      }).pipe(Effect.provide(Reactivity.layer), Scope.provide(scope)),
    );

    const check = startup ? this.startupCheck(sql, false) : Effect.void;

    await Effect.runPromise(
      sql
        .withTransaction(
          Effect.gen(function* () {
            // Restore and a first start against an empty DB must never pass their checks concurrently.
            yield* sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('canopy.gateway_migration.restore', 0))`;
            yield* sql`SELECT pg_advisory_lock_shared(hashtextextended(${relocationRuntimeLock}, 0))`;
            yield* check;
          }),
        )
        .pipe(Effect.timeout("12 seconds")),
    );

    return sql;
  }

  private client(startup = false) {
    if (this.#closing) throw new Error("The gateway relocation guard is closing");

    if (!this.#session) {
      const scope = Scope.makeUnsafe();
      this.#session = { scope, client: this.connect(scope, startup) };
    }

    return this.#session.client;
  }

  get draining() {
    return this.#closing || !this.#ready || this.relocating;
  }

  get relocating() {
    return this.#operationId !== undefined;
  }

  get requestsIdle() {
    return this.#requests === 0;
  }

  readonly interceptor: Interceptor = (next) => async (request) => {
    if (
      [WorkerLinkService.typeName, update.UpdateService.typeName].includes(request.service.typeName) ||
      request.method === link.ComputerLinkService.method.connect
    )
      return next(request);
    const release = this.admit(request.method);

    if (!release) return next(request);

    try {
      const response = await next(request);

      if (response.stream) return { ...response, message: this.track(response.message, release) };
      release();

      return response;
    } catch (error) {
      release();
      throw error;
    }
  };

  async *guardLinkCall<A>(method: DescMethod, input: Message, messages: AsyncIterable<A>) {
    const control =
      method === link.LinkedAgentsService.method.callAgentBus &&
      isMessage(input, link.LinkedAgentCallSchema) &&
      finishAgentWork.has(input.operation);

    const release = this.admit(method, control);

    yield* release ? this.track(messages, release) : messages;
  }

  private admit(method: DescMethod, linkedControl = false) {
    const gateway = method.parent.typeName === ui.GatewayService.typeName;
    const control = linkedControl || (gateway && finishWork.has(method.name)) || finishLinkedWork.has(method);

    if (this.draining && !control) throw new ConnectError("Gateway maintenance is in progress", Code.Unavailable);

    if (method.methodKind !== "unary" && !(gateway && workStreams.has(method.name))) return;
    this.#requests++;

    return () => {
      this.#requests--;
    };
  }

  private async *track<A>(messages: AsyncIterable<A>, release: () => void) {
    try {
      yield* messages;
    } finally {
      release();
    }
  }

  private startupCheck(sql: PgClient.PgClient, requireSchema: boolean) {
    return Effect.gen(function* () {
      const [table] = yield* sql<{ exists: boolean }>`SELECT to_regclass(${relocationTable}) IS NOT NULL AS exists`;

      if (!table?.exists) {
        if (requireSchema) return yield* Effect.fail(new Error("Apply gateway database migration 0188 before startup"));

        return;
      }

      const [fence] = yield* sql<{ state: string }>`SELECT state FROM public.gateway_relocation_fence`;

      if (fence) return yield* Effect.fail(new StartupFenced("Gateway startup blocked by a relocation fence"));
    });
  }

  async assertReady(): Promise<void> {
    if (!this.#ready) throw new Error("The gateway relocation guard is reconnecting");
    const sql = await this.client();

    await Effect.runPromise(this.startupCheck(sql, true));
  }

  private async readFence() {
    const sql = await this.client();

    return Effect.runPromise(
      sql<{ operation_id: string; state: string; idle: boolean }>`SELECT operation_id, state,
        ${sql.literal(relocationIdle)} AS idle FROM public.gateway_relocation_fence`.pipe(Effect.timeout("6 seconds")),
    );
  }

  async refresh(): Promise<boolean | undefined> {
    const rows = await this.readFence().catch(async () => {
      this.#ready = false;
      await this.release();

      return undefined;
    });

    if (!rows || this.#closing) return undefined;
    const [row] = rows;
    this.#operationId = row?.operation_id;
    this.#ready = true;

    if (row && row.state !== "draining") throw new StartupFenced("Gateway shutdown required by a relocation fence");

    return row?.idle ?? false;
  }

  async claimShutdown(): Promise<boolean> {
    const id = this.#operationId;

    if (!id) return false;
    const sql = await this.client();

    return Effect.runPromise(
      sql.withTransaction(
        Effect.gen(function* () {
          // An abort either removes the fence first or observes our claim while clearing it.
          yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${relocationOperatorLock}, 0))`;

          const [row] = yield* sql<{ idle: boolean }>`SELECT ${sql.literal(relocationIdle)} AS idle
            FROM public.gateway_relocation_fence WHERE operation_id = ${id}::uuid AND state = 'draining'`;

          if (!row?.idle) return false;
          yield* sql`SELECT pg_advisory_lock_shared(hashtextextended(${relocationShutdownLock}, 0))`;

          return true;
        }),
      ),
    );
  }

  async close() {
    this.#closing = true;
    await this.release();
  }

  private async release() {
    const session = this.#session;
    this.#session = undefined;

    if (session) await Effect.runPromise(Scope.close(session.scope, Exit.void));
  }
}
