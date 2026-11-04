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
  type CommandResultSchema,
  type InputAttachment,
  type UserInput,
  type InteractionRequest,
  type ProfileModelsSchema,
  type WorkerConfig,
} from "@canopy/contracts";
import { migrate } from "@canopy/db";
import { startPostgres, type TestPostgres } from "@canopy/db/testing";
import { serviceTokenAuth, uiRoutes } from "@canopy/gateway/api";
import { GatewayCore, type GatewayCoreOptions } from "@canopy/gateway/core";
import {
  AgentBusStore,
  AttachmentStore,
  BackgroundTaskStore,
  GatewayStore,
  GoalStore,
  Ingest,
  ModelStore,
  InstanceStore,
  QueueStore,
  SettingsStore,
  SteerStore,
} from "@canopy/gateway/store";
import type { AttachmentLimits, JsonValue } from "@canopy/domain";
import { startGrpcServer } from "@canopy/transport";
import { applyWorkerConfig } from "@canopy/worker/config";
import { openGatewayLink, type GatewayLink } from "@canopy/worker/gateway-link";
import { ThreadSecretFiles } from "@canopy/worker/runtime";
import { Layer, ManagedRuntime } from "effect";
import type { SqlClient } from "effect/sql";
import { BotStore } from "../../../apps/gateway/src/bots/store.ts";
import type { BotModel } from "../../../apps/gateway/src/bots/types.ts";

export const SERVICE_TOKEN = "t".repeat(48);

export type TestRuntime = ManagedRuntime.ManagedRuntime<
  | GatewayStore
  | Ingest
  | AgentBusStore
  | SettingsStore
  | ModelStore
  | SteerStore
  | QueueStore
  | GoalStore
  | InstanceStore
  | AttachmentStore
  | BackgroundTaskStore
  | BotStore
  | SqlClient.SqlClient,
  unknown
>;

/** Where the scripted worker keeps attachments (Hello.attachments_root). */
export const SCRIPTED_ATTACHMENTS_ROOT = "/data/attachments";

/** The scripted worker's Codex models (native profile): what a real worker would list. */
export const SCRIPTED_MODELS: MessageInitShape<typeof ProfileModelsSchema>[] = [
  {
    provider: Provider.CODEX,
    profileId: "native",
    models: [
      {
        id: "gpt-6.1-sol",
        displayName: "GPT-6.1-Sol",
        isDefault: true,
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "low",
      },
      { id: "gpt-5.5", displayName: "GPT-5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    ],
  },
];

type CommandKind = Command["kind"];

/** Takes over a command kind; reply() answers the command. */
export type CommandHandler = (
  value: NonNullable<CommandKind["value"]>,
  reply: (ok: boolean, extra?: CommandReplyExtra) => void,
) => void;

/** Result fields a handler adds to its command's reply. */
export type CommandReplyExtra = Omit<MessageInitShape<typeof CommandResultSchema>, "$typeName" | "commandId" | "ok">;

export interface ScriptedWorkerOptions {
  readonly secretsDataDir?: string;
  /** Report Claude as available (default: only Codex). */
  readonly claude?: boolean;
  /** Its model catalog (default SCRIPTED_MODELS: Codex only). */
  readonly models?: MessageInitShape<typeof ProfileModelsSchema>[];
  /** More Hello fields (e.g. capabilities and running_turns of a restarted worker). */
  readonly hello?: Pick<
    MessageInitShape<typeof HelloSchema>,
    "capabilities" | "runningTurns" | "attachmentsRoot" | "scratchRoot" | "homeDirectory"
  >;
}

/** Plays a worker: answers commands and emits the events a real provider would. */
export class ScriptedWorker {
  readonly secrets: ThreadSecretFiles | undefined;
  /** Every command received, in order. */
  readonly commands: CommandKind[] = [];
  /** Custom behaviour per command kind (e.g. a turn that keeps running); the default answers otherwise. */
  readonly handlers = new Map<string, CommandHandler>();
  readonly interactionAnswers: { requestId: string; allow: boolean }[] = [];
  /** Threads this worker was asked to create, with their cwd. */
  readonly created: {
    threadId: string;
    cwd: string;
    enableAgentBus: boolean;
    depth: number;
    model: string;
    instructions: string;
    permissionMode: number;
    provider: Provider;
    providerProfileId: string;
  }[] = [];
  /** Inputs of the turns this worker ran, per thread. */
  readonly inputs = new Map<string, string[]>();
  /** The whole input of each started turn (and steer), by turn id (steer: input id). */
  readonly started = new Map<string, UserInput>();
  /** Attachments of each started turn, by turn id. */
  readonly attachments = new Map<string, InputAttachment[]>();
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
  /** Models listed by ListModels (and in the catalog after a config); other Codex profiles list the same ones. */
  models: MessageInitShape<typeof ProfileModelsSchema>[];
  /** Every configuration the gateway sent, in order (with its secrets, as a real worker gets them). */
  readonly configs: WorkerConfig[] = [];
  #profiles: string[] = [];
  readonly #running = new Map<string, string>();
  readonly #seq = new Map<string, bigint>();
  readonly #toolResults = new Map<string, (result: AgentToolResult) => void>();
  readonly #fetches = new Map<
    string,
    { chunks: Uint8Array[]; resolve: (result: { data?: Uint8Array; error?: string }) => void }
  >();
  constructor(
    readonly link: GatewayLink,
    readonly options: ScriptedWorkerOptions = {},
  ) {
    this.models = options.models ?? SCRIPTED_MODELS;
    this.secrets = options.secretsDataDir ? new ThreadSecretFiles(options.secretsDataDir) : undefined;
    void this.#loop();
  }

  emit(
    threadId: string,
    turnId: string,
    body: MessageInitShape<typeof ThreadEventSchema>["body"],
    rawJson = "{}",
  ): void {
    const journalSeq = (this.#seq.get(threadId) ?? 0n) + 1n;
    this.#seq.set(threadId, journalSeq);
    this.link.send({
      case: "threadEvent",
      value: create(ThreadEventSchema, {
        threadId,
        turnId,
        journalSeq,
        eventId: Bun.randomUUIDv7(),
        ...(body && { body }),
        rawJson,
      }),
    });
  }

  /** What the provider does when the model calls an agent bus tool. */
  callTool(input: {
    threadId: string;
    turnId?: string;
    tool: string;
    args: JsonValue;
    callId?: string;
    connectorAccountId?: string;
  }): Promise<AgentToolResult> {
    const callId = input.callId ?? Bun.randomUUIDv7();

    return new Promise((resolve) => {
      this.#toolResults.set(callId, resolve);
      this.link.send({
        case: "agentToolCall",
        value: {
          callId,
          threadId: input.threadId,
          turnId: input.turnId ?? "",
          itemId: `tool-${callId.slice(-6)}`,
          toolName: input.tool,
          argumentsJson: JSON.stringify(input.args),
          connectorAccountId: input.connectorAccountId ?? "",
        },
      });
    });
  }

  /** Ends a held turn like the provider would. */
  finish(threadId: string, turnId: string, text = "done"): void {
    this.#running.delete(threadId);
    this.emit(threadId, turnId, {
      case: "itemCompleted",
      value: {
        item: {
          itemId: `msg-${turnId}`,
          status: ItemStatus.COMPLETED,
          content: { case: "agentMessage", value: { text, phase: "final_answer" } },
        },
      },
    });
    this.emit(threadId, turnId, {
      case: "turnFinished",
      value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: `ct-${turnId.slice(-4)}` },
    });
  }

  /** FetchBlob like a real worker before a turn with attachments: the bytes, or the gateway's error. */
  fetchBlob(threadId: string, sha256: string): Promise<{ data?: Uint8Array; error?: string }> {
    const requestId = Bun.randomUUIDv7();

    return new Promise((resolve) => {
      this.#fetches.set(requestId, { chunks: [], resolve });
      this.link.send({ case: "fetchBlob", value: { requestId, threadId, sha256 } });
    });
  }

  /** Uploads a preview (BlobChunk) in chunks of `chunkBytes`, as a worker does before the event that shows it. */
  uploadPreview(sha256: string, data: Uint8Array, mimeType: string, chunkBytes = 64 * 1024): void {
    for (let offset = 0; offset < data.length; offset += chunkBytes) {
      const end = Math.min(offset + chunkBytes, data.length);
      this.link.send({
        case: "blobChunk",
        value: {
          sha256,
          offset: BigInt(offset),
          data: data.subarray(offset, end),
          last: end === data.length,
          mimeType,
        },
      });
    }
  }

  ask(request: MessageInitShape<typeof ui.InteractionSchema> & Partial<InteractionRequest>): void {
    this.link.send({ case: "interactionRequest", value: request as InteractionRequest });
  }

  /** The models of every Codex profile the last configuration made available. */
  #catalog(): MessageInitShape<typeof ProfileModelsSchema>[] {
    const native = this.models.filter((p) => p.provider === Provider.CODEX && p.profileId === "native");

    return [...this.models, ...this.#profiles.flatMap((profileId) => native.map((p) => ({ ...p, profileId })))];
  }

  async #loop(): Promise<void> {
    for await (const message of this.link.messages) {
      const payload = message.payload;

      if (payload.case === "threadSecretDelivery" && this.secrets) {
        this.link.send({ case: "threadSecretReceipt", value: this.secrets.apply(payload.value) });
        continue;
      }

      if (payload.case === "config") {
        this.configs.push(payload.value);

        // Profiles as the real worker validates and reports them (no CLI probing: the device runs nothing).
        const applied = applyWorkerConfig(payload.value, {
          which: (command) =>
            command === "codex" || (command === "claude" && this.options.claude) ? `/usr/bin/${command}` : null,
          version: () => "0.164.0",
          realDirectory: (path) => path,
        });

        const profiles = applied.report.profiles?.length
          ? applied.report.profiles
          : [
              {
                id: "native",
                kind: ProviderProfileKind.NATIVE,
                providers: [Provider.CLAUDE, Provider.CODEX],
                available: true,
              },
            ];

        this.#profiles = profiles
          .filter((p) => p.available && p.id !== "native" && p.providers?.includes(Provider.CODEX))
          .map((p) => p.id ?? "");
        // Like a real worker: what this device offers (here Codex and its profiles; Claude missing).
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
            profiles,
          },
        });
        this.link.send({
          case: "modelCatalog",
          value: { configVersion: payload.value.version, profiles: this.#catalog() },
        });
      }

      if (payload.case === "blobChunk") {
        const fetch = this.#fetches.get(payload.value.requestId);

        if (!fetch) continue;
        fetch.chunks.push(payload.value.data);

        if (payload.value.last) {
          this.#fetches.delete(payload.value.requestId);
          fetch.resolve(
            payload.value.error
              ? { error: payload.value.error }
              : { data: new Uint8Array(Buffer.concat(fetch.chunks)) },
          );
        }

        continue;
      }

      if (payload.case === "interactionResponse")
        this.interactionAnswers.push({ requestId: payload.value.requestId, allow: payload.value.allow });

      if (payload.case === "agentToolResult") {
        this.#toolResults.get(payload.value.callId)?.(payload.value);
        this.#toolResults.delete(payload.value.callId);
      }

      if (payload.case !== "command") continue;
      const { commandId, kind } = payload.value;

      const reply = (ok: boolean, extra: CommandReplyExtra = {}) =>
        this.link.send({ case: "commandResult", value: { commandId, ok, ...extra } });

      this.commands.push(kind);
      const handler = kind.case ? this.handlers.get(kind.case) : undefined;

      if (handler && kind.value) {
        handler(kind.value, reply);
        continue;
      }

      switch (kind.case) {
        case "listDirectory":
          if (kind.value.path.includes("missing"))
            reply(false, { errorCode: "CWD_NOT_FOUND", errorMessage: `${kind.value.path} does not exist` });
          else
            reply(true, {
              directoryPath: kind.value.path || "/home/test",
              entries: [{ name: "repo-a", isDir: true, isGitRepo: true }],
            });
          break;
        case "createThread": {
          const spec = kind.value.thread!;

          if (spec.cwd.includes("forbidden")) {
            reply(false, { errorCode: "CWD_NOT_FOUND", errorMessage: `${spec.cwd} does not exist` });
            break;
          }

          this.created.push({
            threadId: spec.threadId,
            cwd: spec.cwd,
            enableAgentBus: spec.enableAgentBus,
            depth: spec.depth,
            model: spec.model,
            instructions: spec.instructions,
            permissionMode: spec.permissionMode,
            provider: spec.provider,
            providerProfileId: spec.providerProfileId,
          });
          reply(true);
          this.emit(spec.threadId, "", {
            case: "threadReady",
            value: { providerThreadId: `codex-${spec.threadId.slice(-4)}` },
          });
          break;
        }

        case "listModels":
          reply(true, { models: this.#catalog() });
          break;
        case "steerTurn": {
          const { threadId, turnId, inputId, input } = kind.value;

          if (this.steerMode === "not_running" || this.#running.get(threadId) !== turnId) {
            reply(false, { errorCode: "STEER_NOT_RUNNING", errorMessage: "the turn is not running on this worker" });
            break;
          }

          this.steered.set(inputId, input!.text);
          this.started.set(inputId, input!);
          reply(true);

          if (this.steerMode === "drop") {
            this.emit(threadId, turnId, {
              case: "notice",
              value: {
                level: NoticeLevel.WARNING,
                code: "steer_dropped",
                message: "the message did not join the turn before it ended",
                dataJson: JSON.stringify({ input_id: inputId }),
              },
            });
          } else {
            this.emit(threadId, turnId, {
              case: "itemCompleted",
              value: {
                item: {
                  itemId: `user-${inputId}`,
                  status: ItemStatus.COMPLETED,
                  content: { case: "userMessage", value: { text: input!.text, clientId: inputId } },
                },
              },
            });
          }

          break;
        }

        case "startTurn": {
          const { thread, turnId, input, model, effort, permissionMode } = kind.value;
          const threadId = thread!.threadId;
          this.inputs.set(threadId, [...(this.inputs.get(threadId) ?? []), input!.text]);
          this.attachments.set(turnId, input!.attachments);
          this.started.set(turnId, input!);
          this.turnSettings.set(turnId, { model, effort });
          this.turnModes.set(turnId, { turn: permissionMode, thread: thread!.permissionMode });
          reply(true);
          this.emit(threadId, turnId, {
            case: "turnStarted",
            value: { providerTurnRef: `ct-${turnId.slice(-4)}`, origin: TurnOrigin.COMMAND },
          });

          if (this.holdTurns) {
            this.#running.set(threadId, turnId);
            break;
          }

          this.emit(threadId, turnId, {
            case: "itemCompleted",
            value: {
              item: {
                itemId: `msg-${turnId}`,
                status: ItemStatus.COMPLETED,
                content: { case: "agentMessage", value: { text: `Echo: ${input!.text}`, phase: "final_answer" } },
              },
            },
          });
          this.emit(threadId, turnId, {
            case: "turnFinished",
            value: {
              outcome: TurnOutcome.COMPLETED,
              providerTurnRef: `ct-${turnId.slice(-4)}`,
              usage: { inputTokens: 10n, outputTokens: 2n },
            },
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
  /** CANOPY_SECRETS_KEY of this gateway (linked computers re-encrypt shared secrets with their own). */
  readonly secretsKey: Buffer;
  readonly worker: ScriptedWorker;
  readonly workerId: string;
  /** Ephemeral credential for reconnecting the fixture's primary worker after a gateway restart. */
  readonly workerCredential: string;
  /** Registers another worker; optional roots exercise compatibility with stored old configs. */
  addWorker(name: string, allowedRoots?: string[]): Promise<{ workerId: string; credential: string }>;
  /** Connects a scripted worker; closed with the gateway. */
  connect(workerId: string, credential: string, os?: string, options?: ScriptedWorkerOptions): Promise<ScriptedWorker>;
  close(): Promise<void>;
}

/** Starts PostgreSQL, the gateway (UI API + worker link on one server) and a connected worker "laptop" (root /repo). */
export async function startTestGateway(
  options: {
    cliLatest?: GatewayCoreOptions["cliLatest"];
    updates?: GatewayCoreOptions["updates"];
    attachmentLimits?: AttachmentLimits;
    backgroundGraceMs?: number;
    botModel?: BotModel;
    worker?: ScriptedWorkerOptions;
    secretTtlMs?: number;
  } = {},
): Promise<TestGateway> {
  const pg = await startPostgres();
  const secretsKey = randomBytes(32);

  const runtime: TestRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      GatewayStore.layer(secretsKey),
      Ingest.layer,
      AgentBusStore.layer,
      SettingsStore.layer,
      ModelStore.layer,
      SteerStore.layer,
      QueueStore.layer,
      GoalStore.layer,
      InstanceStore.layer(secretsKey),
      AttachmentStore.layer,
      BackgroundTaskStore.layer,
      BotStore.layer(secretsKey),
    ).pipe(Layer.provideMerge(pg.layer)),
  );

  await runtime.runPromise(migrate);
  const userId = await runtime.runPromise(GatewayStore.use((s) => s.ensureUser("dev@localhost", "Dev")));

  const addWorker = async (name: string, allowedRoots?: string[]) => {
    const added = await runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name, ownerUserId: userId })));
    await runtime.runPromise(
      GatewayStore.use((s) =>
        s.setWorkerConfig(
          added.workerId,
          { ...(allowedRoots && { allowedRoots }), codex: { enabled: true }, claude: { enabled: true } },
          userId,
        ),
      ),
    );
    // Its effective provider instances (the built-in native ones, all workers).
    await runtime.runPromise(InstanceStore.use((s) => s.sync(userId, [added.workerId])));

    return added;
  };

  const core = new GatewayCore({
    runtime,
    instanceId: "test",
    userId,
    sshSecretsKey: secretsKey,
    ...(options.cliLatest && { cliLatest: options.cliLatest }),
    ...(options.updates && { updates: options.updates }),
    ...(options.secretTtlMs !== undefined && { secretTtlMs: options.secretTtlMs }),
    ...(options.botModel && { botModel: options.botModel }),
    ...(options.attachmentLimits && { attachmentLimits: options.attachmentLimits }),
    ...(options.backgroundGraceMs !== undefined && { backgroundGraceMs: options.backgroundGraceMs }),
    log: (m) => (process.env["CANOPY_TEST_LOG"] === "1" || m.startsWith("agent bus")) && console.error(m),
  });

  const grpc = await startGrpcServer({
    routes: (router) => {
      core.link.routes(router);
      core.workers.routes(router);
      uiRoutes(core)(router);
    },
    interceptors: [serviceTokenAuth(SERVICE_TOKEN)],
  });

  const api = createClient(
    ui.GatewayService,
    createGrpcTransport({
      baseUrl: grpc.url,
      interceptors: [
        (next) => (request) => (request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`), next(request)),
      ],
    }),
  );

  const workers: ScriptedWorker[] = [];

  const connect = async (workerId: string, credential: string, os?: string, options?: ScriptedWorkerOptions) => {
    const worker = new ScriptedWorker(
      await openGatewayLink({
        baseUrl: grpc.url,
        credential,
        hello: {
          workerId,
          journalId: `journal-${workerId.slice(-6)}`,
          attachmentsRoot: SCRIPTED_ATTACHMENTS_ROOT,
          scratchRoot: "/worker-data/scratch",
          homeDirectory: "/home/test",
          ...(os && {
            host: { os },
            ...(os === "win32" && { scratchRoot: "C:\\worker-data\\scratch", homeDirectory: "C:\\Users\\test" }),
          }),
          ...options?.hello,
          ...(options?.secretsDataDir && { capabilities: [...(options.hello?.capabilities ?? []), "thread_secrets"] }),
        },
      }),
      options,
    );

    workers.push(worker);

    return worker;
  };

  const laptop = await addWorker("laptop");
  const worker = await connect(laptop.workerId, laptop.credential, undefined, options.worker);
  // Directory validation can finish before configuration/catalog delivery. Return a ready fixture.
  await eventually(
    () => api.getOverview({}),
    (o) => o.workers.some((w) => w.id === laptop.workerId && w.appliedVersion > 0n),
  );
  await eventually(
    () => api.listModels({}),
    (r) => r.workers.some((w) => w.workerId === laptop.workerId && w.configVersion > 0n),
  );

  return {
    pg,
    runtime,
    core,
    api,
    grpcUrl: grpc.url,
    userId,
    secretsKey,
    worker,
    workerId: laptop.workerId,
    workerCredential: laptop.credential,
    addWorker,
    connect,
    close: async () => {
      core.stopSweep();
      await core.bots.stop();

      for (const w of workers) {
        w.link.close();
        w.secrets?.close();
      }

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
    ...updates.flatMap((u) =>
      u.change.case === "event" && u.change.value.event?.body.case === "itemCompleted"
        ? [u.change.value.event.body.value.item]
        : [],
    ),
  ].flatMap((item) => (item?.content.case === "agentMessage" ? [item.content.value.text] : []));

/** Message of the error a call fails with ("" if it succeeds). `await expect(p).rejects` hangs on Connect calls in Bun 1.4. */
export const failure = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "",
    (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  );

/** Polls until the predicate holds (5 s at most). */
export async function eventually<A>(
  read: () => Promise<A>,
  done: (value: A) => boolean,
  timeoutMs = 5_000,
): Promise<A> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await read();

    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(25);
  }
}
