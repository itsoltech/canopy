/**
 * Gateway on PostgreSQL with a scripted worker, for end-to-end tests of the UI API and the agent bus:
 * BFF client (gRPC, service token) -> GatewayService -> core -> outbox -> worker link -> scripted worker
 * -> events -> ingest -> live updates.
 */
import { randomBytes } from "node:crypto";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
  ItemStatus,
  NoticeLevel,
  PermissionMode,
  Provider,
  ProviderProfileKind,
  ThreadEventSchema,
  type HelloSchema,
  TurnOrigin,
  TurnOutcome,
  ui,
  type AgentToolResult,
  type Command,
  type InteractionRequest,
  type ProfileModelsSchema,
} from "@open-agents/contracts";
import { migrate } from "@open-agents/db";
import { startPostgres, type TestPostgres } from "@open-agents/db/testing";
import { serviceTokenAuth, uiRoutes } from "@open-agents/gateway/api";
import { GatewayCore } from "@open-agents/gateway/core";
import { AgentBusStore, GatewayStore, GoalStore, Ingest, ModelStore, SettingsStore, SteerStore } from "@open-agents/gateway/store";
import { startGrpcServer } from "@open-agents/transport";
import { openGatewayLink, type GatewayLink } from "@open-agents/worker/gateway-link";
import { Layer, ManagedRuntime } from "effect";
import type { SqlClient } from "effect/sql";

export const SERVICE_TOKEN = "t".repeat(48);

export type TestRuntime = ManagedRuntime.ManagedRuntime<GatewayStore | Ingest | AgentBusStore | SettingsStore | ModelStore | SteerStore | GoalStore | SqlClient.SqlClient, unknown>;

/** The scripted worker's Codex models (native profile): what a real worker would list. */
export const SCRIPTED_MODELS: MessageInitShape<typeof ProfileModelsSchema>[] = [
  {
    provider: Provider.CODEX,
    profileId: "native",
    models: [
      { id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "low" },
      { id: "gpt-5.5", displayName: "GPT-5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    ],
  },
];

type CommandKind = Command["kind"];
/** Takes over a command kind; reply() answers the command. */
export type CommandHandler = (value: NonNullable<CommandKind["value"]>, reply: (ok: boolean, extra?: Record<string, unknown>) => void) => void;

export interface ScriptedWorkerOptions {
  /** Report Claude as available (default: only Codex). */
  readonly claude?: boolean;
  /** More Hello fields (e.g. capabilities and running_turns of a restarted worker). */
  readonly hello?: Pick<MessageInitShape<typeof HelloSchema>, "capabilities" | "runningTurns">;
}

/** Plays a worker: answers commands and emits the events a real provider would. */
export class ScriptedWorker {
  /** Every command received, in order. */
  readonly commands: CommandKind[] = [];
  /** Custom behaviour per command kind (e.g. a turn that keeps running); the default answers otherwise. */
  readonly handlers = new Map<string, CommandHandler>();
  readonly interactionAnswers: { requestId: string; allow: boolean }[] = [];
  /** Threads this worker was asked to create, with their cwd. */
  readonly created: {
    threadId: string; cwd: string; enableAgentBus: boolean; depth: number; model: string; instructions: string; permissionMode: number;
  }[] = [];
  /** Inputs of the turns this worker ran, per thread. */
  readonly inputs = new Map<string, string[]>();
  /** Model and effort each turn was started with, by turn id. */
  readonly turnSettings = new Map<string, { model: string; effort: string }>();
  /** StartTurn.permission_mode and the thread's mode (ThreadSpec) per turn. */
  readonly turnModes = new Map<string, { turn: PermissionMode; thread: PermissionMode }>();
  /** Steers this worker got: input id -> text. */
  readonly steered = new Map<string, string>();
  /** Turns stay running until finish() (to steer into them). */
  holdTurns = false;
  /** What a SteerTurn does: join the turn, find it over, or be taken and then dropped (Claude, turn ended first). */
  steerMode: "accept" | "not_running" | "drop" = "accept";
  /** Models listed by ListModels (and in the catalog after a config). */
  models = SCRIPTED_MODELS;
  readonly #running = new Map<string, string>();
  readonly #seq = new Map<string, bigint>();
  readonly #toolResults = new Map<string, (result: AgentToolResult) => void>();
  constructor(
    readonly link: GatewayLink,
    readonly options: ScriptedWorkerOptions = {},
  ) {
    void this.#loop();
  }

  emit(threadId: string, turnId: string, body: NonNullable<MessageInitShape<typeof ThreadEventSchema>["body"]>): void {
    const journalSeq = (this.#seq.get(threadId) ?? 0n) + 1n;
    this.#seq.set(threadId, journalSeq);
    this.link.send({ case: "threadEvent", value: create(ThreadEventSchema, { threadId, turnId, journalSeq, eventId: Bun.randomUUIDv7(), body, rawJson: "{}" }) });
  }

  /** What the provider does when the model calls an agent bus tool. */
  callTool(input: { threadId: string; turnId?: string; tool: string; args: unknown; callId?: string }): Promise<AgentToolResult> {
    const callId = input.callId ?? Bun.randomUUIDv7();
    return new Promise((resolve) => {
      this.#toolResults.set(callId, resolve);
      this.link.send({
        case: "agentToolCall",
        value: { callId, threadId: input.threadId, turnId: input.turnId ?? "", itemId: `tool-${callId.slice(-6)}`, toolName: input.tool, argumentsJson: JSON.stringify(input.args) },
      });
    });
  }

  /** Ends a held turn like the provider would. */
  finish(threadId: string, turnId: string, text = "done"): void {
    this.#running.delete(threadId);
    this.emit(threadId, turnId, {
      case: "itemCompleted",
      value: { item: { itemId: `msg-${turnId}`, status: ItemStatus.COMPLETED, content: { case: "agentMessage", value: { text, phase: "final_answer" } } } },
    });
    this.emit(threadId, turnId, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: `ct-${turnId.slice(-4)}` } });
  }

  ask(request: MessageInitShape<typeof ui.InteractionSchema> & Partial<InteractionRequest>): void {
    this.link.send({ case: "interactionRequest", value: request as InteractionRequest });
  }

  async #loop(): Promise<void> {
    for await (const message of this.link.messages) {
      const payload = message.payload;
      if (payload.case === "config") {
        // Like a real worker: what this device offers (here Codex and a native profile; Claude missing).
        this.link.send({
          case: "configApplied",
          value: {
            version: payload.value.version,
            applied: true,
            providers: [
              { provider: Provider.CODEX, available: true, version: "0.164.0" },
              this.options.claude
                ? { provider: Provider.CLAUDE, available: true, version: "2.1.316" }
                : { provider: Provider.CLAUDE, available: false, detail: "claude CLI not found" },
            ],
            profiles: [{ id: "native", kind: ProviderProfileKind.NATIVE, providers: [Provider.CLAUDE, Provider.CODEX], available: true }],
          },
        });
        this.link.send({ case: "modelCatalog", value: { configVersion: payload.value.version, profiles: this.models } });
      }
      if (payload.case === "interactionResponse") this.interactionAnswers.push({ requestId: payload.value.requestId, allow: payload.value.allow });
      if (payload.case === "agentToolResult") {
        this.#toolResults.get(payload.value.callId)?.(payload.value);
        this.#toolResults.delete(payload.value.callId);
      }
      if (payload.case !== "command") continue;
      const { commandId, kind } = payload.value;
      const reply = (ok: boolean, extra: Record<string, unknown> = {}) => this.link.send({ case: "commandResult", value: { commandId, ok, ...extra } });
      this.commands.push(kind);
      const handler = kind.case ? this.handlers.get(kind.case) : undefined;
      if (handler && kind.value) {
        handler(kind.value, reply);
        continue;
      }
      switch (kind.case) {
        case "listDirectory":
          reply(true, { entries: [{ name: "repo-a", isDir: true, isGitRepo: true }] });
          break;
        case "createThread": {
          const spec = kind.value.thread!;
          if (spec.cwd.includes("forbidden")) {
            reply(false, { errorCode: "CWD_NOT_ALLOWED", errorMessage: `${spec.cwd} is outside the allowed roots` });
            break;
          }
          this.created.push({
            threadId: spec.threadId, cwd: spec.cwd, enableAgentBus: spec.enableAgentBus, depth: spec.depth,
            model: spec.model, instructions: spec.instructions, permissionMode: spec.permissionMode,
          });
          reply(true);
          this.emit(spec.threadId, "", { case: "threadReady", value: { providerThreadId: `codex-${spec.threadId.slice(-4)}` } });
          break;
        }
        case "listModels":
          reply(true, { models: this.models });
          break;
        case "steerTurn": {
          const { threadId, turnId, inputId, input } = kind.value;
          if (this.steerMode === "not_running" || this.#running.get(threadId) !== turnId) {
            reply(false, { errorCode: "STEER_NOT_RUNNING", errorMessage: "the turn is not running on this worker" });
            break;
          }
          this.steered.set(inputId, input!.text);
          reply(true);
          if (this.steerMode === "drop") {
            this.emit(threadId, turnId, {
              case: "notice",
              value: { level: NoticeLevel.WARNING, code: "steer_dropped", message: "the message did not join the turn before it ended", dataJson: JSON.stringify({ input_id: inputId }) },
            });
          } else {
            this.emit(threadId, turnId, {
              case: "itemCompleted",
              value: { item: { itemId: `user-${inputId}`, status: ItemStatus.COMPLETED, content: { case: "userMessage", value: { text: input!.text, clientId: inputId } } } },
            });
          }
          break;
        }
        case "startTurn": {
          const { thread, turnId, input, model, effort, permissionMode } = kind.value;
          const threadId = thread!.threadId;
          this.inputs.set(threadId, [...(this.inputs.get(threadId) ?? []), input!.text]);
          this.turnSettings.set(turnId, { model, effort });
          this.turnModes.set(turnId, { turn: permissionMode, thread: thread!.permissionMode });
          reply(true);
          this.emit(threadId, turnId, { case: "turnStarted", value: { providerTurnRef: `ct-${turnId.slice(-4)}`, origin: TurnOrigin.COMMAND } });
          if (this.holdTurns) {
            this.#running.set(threadId, turnId);
            break;
          }
          this.emit(threadId, turnId, {
            case: "itemCompleted",
            value: { item: { itemId: `msg-${turnId}`, status: ItemStatus.COMPLETED, content: { case: "agentMessage", value: { text: `Echo: ${input!.text}`, phase: "final_answer" } } } },
          });
          this.emit(threadId, turnId, {
            case: "turnFinished",
            value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: `ct-${turnId.slice(-4)}`, usage: { inputTokens: 10n, outputTokens: 2n } },
          });
          break;
        }
        default:
          reply(true);
      }
    }
  }
}

export interface TestGateway {
  readonly pg: TestPostgres;
  readonly runtime: TestRuntime;
  readonly core: GatewayCore;
  readonly api: Client<typeof ui.GatewayService>;
  readonly grpcUrl: string;
  readonly userId: string;
  readonly worker: ScriptedWorker;
  readonly workerId: string;
  /** Registers another worker (not connected) with its own allowed roots. */
  addWorker(name: string, allowedRoots: string[]): Promise<{ workerId: string; credential: string }>;
  /** Connects a scripted worker; closed with the gateway. */
  connect(workerId: string, credential: string, os?: string, options?: ScriptedWorkerOptions): Promise<ScriptedWorker>;
  close(): Promise<void>;
}

/** Starts PostgreSQL, the gateway (UI API + worker link on one server) and a connected worker "laptop" (root /repo). */
export async function startTestGateway(): Promise<TestGateway> {
  const pg = await startPostgres();
  const runtime: TestRuntime = ManagedRuntime.make(
    Layer.mergeAll(GatewayStore.layer(randomBytes(32)), Ingest.layer, AgentBusStore.layer, SettingsStore.layer, ModelStore.layer, SteerStore.layer, GoalStore.layer).pipe(Layer.provideMerge(pg.layer)),
  );
  await runtime.runPromise(migrate);
  const userId = await runtime.runPromise(GatewayStore.use((s) => s.ensureUser("dev@localhost", "Dev")));
  const addWorker = async (name: string, allowedRoots: string[]) => {
    const added = await runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name, ownerUserId: userId })));
    await runtime.runPromise(GatewayStore.use((s) => s.setWorkerConfig(added.workerId, { allowedRoots, codex: { enabled: true } }, userId)));
    return added;
  };
  const core = new GatewayCore({ runtime, instanceId: "test", userId, log: (m) => (process.env["OA_TEST_LOG"] === "1" || m.startsWith("agent bus")) && console.error(m) });
  const grpc = await startGrpcServer({
    routes: (router) => {
      core.link.routes(router);
      uiRoutes(core)(router);
    },
    interceptors: [serviceTokenAuth(SERVICE_TOKEN)],
  });
  const api = createClient(
    ui.GatewayService,
    createGrpcTransport({
      baseUrl: grpc.url,
      interceptors: [(next) => (request) => (request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`), next(request))],
    }),
  );
  const workers: ScriptedWorker[] = [];
  const connect = async (workerId: string, credential: string, os?: string, options?: ScriptedWorkerOptions) => {
    const worker = new ScriptedWorker(
      await openGatewayLink({
        baseUrl: grpc.url,
        credential,
        hello: { workerId, journalId: `journal-${workerId.slice(-6)}`, ...(os && { host: { os } }), ...options?.hello },
      }),
      options,
    );
    workers.push(worker);
    return worker;
  };
  const laptop = await addWorker("laptop", ["/repo"]);
  const worker = await connect(laptop.workerId, laptop.credential);
  return {
    pg,
    runtime,
    core,
    api,
    grpcUrl: grpc.url,
    userId,
    worker,
    workerId: laptop.workerId,
    addWorker,
    connect,
    close: async () => {
      for (const w of workers) w.link.close();
      await core.link.shutdown();
      await grpc.close();
      await runtime.dispose();
      pg.stop();
    },
  };
}

/** Collects WatchThread updates until the predicate holds (10 s at most by default). */
export async function watchUntil(
  api: Client<typeof ui.GatewayService>,
  threadId: string,
  done: (updates: ui.ThreadUpdate[]) => boolean,
  onUpdate?: (u: ui.ThreadUpdate) => void,
  timeoutMs = 10_000,
): Promise<ui.ThreadUpdate[]> {
  const controller = new AbortController();
  const updates: ui.ThreadUpdate[] = [];
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for await (const update of api.watchThread({ threadId }, { signal: controller.signal })) {
      updates.push(update);
      onUpdate?.(update);
      if (done(updates)) break;
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return updates;
}

/** Agent messages in a list of updates (snapshot items and live events). */
export const answers = (updates: ui.ThreadUpdate[]) =>
  [
    ...updates.flatMap((u) => (u.change.case === "snapshot" ? u.change.value.items.map((i) => i.item) : [])),
    ...updates.flatMap((u) => (u.change.case === "event" && u.change.value.event?.body.case === "itemCompleted" ? [u.change.value.event.body.value.item] : [])),
  ].flatMap((item) => (item?.content.case === "agentMessage" ? [item.content.value.text] : []));

/** Message of the error a call fails with ("" if it succeeds). `await expect(p).rejects` hangs on Connect calls in Bun 1.4. */
export const failure = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );

/** Polls until the predicate holds (5 s at most). */
export async function eventually<A>(read: () => Promise<A>, done: (value: A) => boolean, timeoutMs = 5_000): Promise<A> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(25);
  }
}
