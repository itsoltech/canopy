import { workerDiagnostics } from "../../diagnostics/worker.ts";
import { Effect, Schema } from "effect";
import { threadLifecycle } from "../thread-lifecycle.ts";
import { TurnAdmissionCancelled } from "../turn-input.ts";
import { agentBusToolsFor, classifyFailure, safeFailureDetail, type JsonValue } from "@canopy/domain";
import { GrokClient, type SessionResult } from "@canopy/grok-acp";
import {
  ItemStatus,
  PermissionMode,
  TurnEndSource,
  TurnOutcome,
  type AgentToolCall,
  type AgentToolResult,
  type ForkSpec,
  type InteractionRequest,
  type InteractionResponse,
  type ThreadEvent,
  type ThreadSpec,
  type AgentTool,
  type UserInput,
} from "@canopy/contracts";
import type { ThreadEventInit } from "../../journal/index.ts";
import type { ViewImageResult } from "../../images/index.ts";
import { proxyModelFits, proxyModels, type ModelInit } from "../models.ts";
import { concreteModelName } from "../model-metadata.ts";
import type { ResolvedProfile } from "../profiles.ts";
import type { TurnSettings } from "../turn-input.ts";
import { grokPrompt } from "./input.ts";
import { grokLaunch } from "./launch.ts";
import { grokBus, platformToolName } from "./bus.ts";
import { GrokSessionCost } from "./consumed-usage.ts";
import { GrokEventMapper } from "./mapping.ts";
import { discoveredModels } from "./model-discovery.ts";
import { automationMcp, automationMcpKey } from "../local-automation.ts";
import type { LocalAgentToolMcpServer } from "../../agent-tools/index.ts";
import { closeGrokResources, grokPermission } from "./lifecycle.ts";

const ToolInput = Schema.Struct({
  tool_name: Schema.optionalKey(Schema.String),
  tool_input: Schema.optionalKey(Schema.Json),
});

interface Options {
  dataDir: string;
  executable: string;
  linkDeviceLogin: boolean;
  idleUnloadMs?: number;
  profile(id: string): ResolvedProfile | undefined;
  record(threadId: string, init: ThreadEventInit): Promise<ThreadEvent>;
  interact(request: InteractionRequest, signal?: AbortSignal): Promise<InteractionResponse>;
  callTool(call: AgentToolCall, signal?: AbortSignal): Promise<AgentToolResult>;
  viewImage?(threadId: string, cwd: string, path: string): Promise<ViewImageResult>;
  /** Local automation MCP servers resolved by the worker from gateway-approved tool ids. */
  localMcpServers?(
    tools: readonly AgentTool[],
    threadId: string,
    defaults?: ThreadSpec["agentToolDefaults"],
  ): readonly LocalAgentToolMcpServer[];
}

interface Entry {
  client: GrokClient;
  session: SessionResult;
  dispose(): Promise<void>;
  turnId: string;
  mode: PermissionMode;
  interrupted: boolean;
  settings: string;
  costs: GrokSessionCost;
  toolUses: Map<string, { name: string; args: JsonValue }>;
  approvals: Set<string>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** Worker registry with the same lifecycle operations as ClaudeThreads/CodexThreads; one ACP process per thread. */
export class GrokThreads {
  readonly #entries = new Map<string, Entry>();
  readonly #preparing = new Map<string, () => Promise<void>>();
  readonly #lifecycle = threadLifecycle((threadId) => new Error(`Thread ${threadId} is being unloaded`));
  constructor(readonly options: Options) {}
  running(threadId: string): boolean {
    return !!this.#entries.get(threadId)?.turnId;
  }
  async create(spec: ThreadSpec, fork?: ForkSpec): Promise<string> {
    if (fork) throw new Error("Grok ACP does not expose session fork");
    const entry = await this.#open(spec);
    await this.options.record(spec.threadId, {
      body: { case: "threadReady", value: { providerThreadId: entry.session.sessionId } },
    });

    if (this.#entries.get(spec.threadId) === entry) this.#idle(spec.threadId, entry);

    return entry.session.sessionId;
  }
  #open(spec: ThreadSpec, settings?: TurnSettings): Promise<Entry> {
    return Effect.runPromise(
      this.#lifecycle.run(spec.threadId, (current) =>
        Effect.tryPromise({
          try: () => {
            const serviceTier = settings?.serviceTier || spec.serviceTier || "default";

            if (serviceTier !== "default") throw new Error("Grok ACP does not support independent speed tiers.");

            return this.#openSession(spec, settings, current);
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
      ),
    );
  }
  async #openSession(spec: ThreadSpec, settings: TurnSettings | undefined, current: () => boolean): Promise<Entry> {
    const profile = this.options.profile(spec.providerProfileId);

    if (!profile) throw new Error("Grok provider instance unavailable");

    const chosen = {
      model: settings?.model || spec.model,
      effort: settings?.effort || "",
      permissionMode: settings?.permissionMode || spec.permissionMode,
    };

    const key = JSON.stringify([chosen, spec.connectorTools, spec.hasDelegatingBot, automationMcpKey(spec)]);
    const previous = this.#entries.get(spec.threadId);

    if (previous?.turnId) throw new Error("Grok turn already running");

    if (previous?.settings === key && !previous.client.closed) {
      clearTimeout(previous.idleTimer);

      return previous;
    }

    const sessionId = previous?.session.sessionId || spec.providerThreadId;

    if (previous) {
      this.#entries.delete(spec.threadId);
      await previous.dispose();
    }

    const launch = grokLaunch({
      dataDir: this.options.dataDir,
      // Fresh GROK_HOME has no trusted projects. Scratch must never trust an enclosing repository.
      profile: spec.scratch ? { ...profile, env: { ...profile.env, GROK_FOLDER_TRUST: "1" } } : profile,
      executable: this.options.executable,
      model: chosen.model,
      effort: chosen.effort,
      readOnly: chosen.permissionMode === PermissionMode.READ_ONLY,
      fullAuto: chosen.permissionMode === PermissionMode.FULL_AUTO,
      fullAccess: chosen.permissionMode === PermissionMode.FULL_ACCESS,
      linkDeviceLogin: this.options.linkDeviceLogin,
    });

    let entry: Entry | undefined;
    let automation: ReturnType<typeof automationMcp> | undefined;
    let bus: ReturnType<typeof grokBus> | undefined;
    let client: GrokClient | undefined;
    let disposed: Promise<void> | undefined;

    const dispose = async () => {
      clearTimeout(entry?.idleTimer);
      disposed ??= closeGrokResources([
        () => client?.dispose(),
        () => bus?.close(),
        () => automation?.close(),
        launch.cleanup,
      ]);
      await disposed;
    };

    try {
      automation = automationMcp(this.options, spec, () => entry?.turnId ?? "");
      bus = grokBus({
        threadId: spec.threadId,
        depth: spec.depth,
        agentBus: spec.enableAgentBus ? agentBusToolsFor(spec.depth, spec.hasDelegatingBot) : false,
        turnId: () => entry?.turnId ?? "",
        callTool: this.options.callTool,
        connectorTools: spec.connectorTools,
        record: (event) => this.options.record(spec.threadId, event),
        ...(this.options.viewImage && {
          viewImage: (path: string) => this.options.viewImage!(spec.threadId, spec.cwd, path),
        }),
        toolUseId: (name, args) => {
          for (const [id, use] of entry?.toolUses ?? [])
            if (use.name === name && JSON.stringify(use.args) === JSON.stringify(args)) {
              entry?.toolUses.delete(id);

              return `${entry?.turnId}:${id}`;
            }

          return undefined;
        },
      });
      client = new GrokClient({
        ...launch.options,
        callbacks: {
          requestPermission: (request, signal) => grokPermission(spec, entry, request, signal, this.options.interact),
        },
      });
      this.#preparing.set(spec.threadId, dispose);
      const info = await client.initialize();

      if ((bus || automation) && !info.agentCapabilities?.mcpCapabilities?.http)
        throw new Error("Installed Grok lacks HTTP MCP support");

      const servers = [
        ...(bus ? [bus.server] : []),
        ...(automation?.servers.map((server) => ({
          type: "http" as const,
          name: server.name,
          url: server.url,
          headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
        })) ?? []),
      ];

      const session = sessionId
        ? await client.loadSession(sessionId, spec.cwd, servers)
        : await client.newSession(spec.cwd, servers);

      if (chosen.model && session.models && session.models.currentModelId !== chosen.model)
        await client.setModel(session.sessionId, chosen.model);
      entry = {
        client,
        session,
        dispose,
        turnId: "",
        mode: chosen.permissionMode,
        interrupted: false,
        settings: key,
        costs: new GrokSessionCost(Boolean(sessionId)),
        toolUses: new Map(),
        approvals: new Set(),
      };

      if (!current() || settings?.canSubmit?.() === false) throw new TurnAdmissionCancelled();
      this.#entries.set(spec.threadId, entry);

      return entry;
    } catch (error) {
      let cleanupError: unknown;

      try {
        await dispose();
      } catch (closeError) {
        cleanupError = closeError;
      }

      if (cleanupError) throw new AggregateError([error, cleanupError], "Grok session setup and cleanup failed");

      throw error;
    } finally {
      this.#preparing.delete(spec.threadId);
    }
  }
  async startTurn(spec: ThreadSpec, turnId: string, input: UserInput, settings?: TurnSettings): Promise<void> {
    if (settings?.canSubmit?.() === false) return;

    // The outbox replays StartTurn after a reconnect while the original prompt may still await an interaction.
    if (this.#entries.get(spec.threadId)?.turnId === turnId) return;
    workerDiagnostics.turns.begin(spec.threadId, turnId, "grok");

    const entry = await this.#open(spec, settings).catch((error) => {
      workerDiagnostics.turns.finish(spec.threadId, turnId, true);
      throw error;
    });

    await settings?.connectorsReady?.();

    if (this.#entries.get(spec.threadId) !== entry || settings?.canSubmit?.() === false) {
      workerDiagnostics.turns.finish(spec.threadId, turnId, true);

      return;
    }

    entry.turnId = turnId;
    entry.interrupted = false;
    entry.toolUses.clear();
    const mapper = new GrokEventMapper(turnId, spec.cwd, settings?.model || spec.model, entry.costs);
    const record = (init: ThreadEventInit) => this.options.record(spec.threadId, init);
    await record({ turnId, body: { case: "turnStarted", value: { model: settings?.model || spec.model } } });
    await record({
      turnId,
      body: {
        case: "itemCompleted",
        value: {
          item: {
            itemId: `${turnId}:input`,
            status: ItemStatus.COMPLETED,
            content: { case: "userMessage", value: { text: input.text, clientId: turnId, mentions: input.mentions } },
          },
        },
      },
    });
    let outcome = TurnOutcome.COMPLETED;
    let reason = "";
    let errorCode = "";

    try {
      const prompt = await grokPrompt(
        spec.instructions,
        settings?.connectorNote ? { ...input, text: `${input.text}\n\n${settings.connectorNote}` } : input,
        entry.client.capabilities?.agentCapabilities?.promptCapabilities?.image === true,
      );

      if (this.#entries.get(spec.threadId) !== entry || settings?.canSubmit?.() === false)
        throw new TurnAdmissionCancelled();

      for await (const event of entry.client.prompt(entry.session.sessionId, prompt)) {
        if (event.type === "update") {
          const update = event.update;

          if (update.sessionUpdate === "tool_call" && update.title === "use_tool") {
            const input = Schema.decodeUnknownSync(Schema.UndefinedOr(ToolInput))(update.rawInput);
            const platformTool = input?.tool_name === undefined ? undefined : platformToolName(input.tool_name);

            if (platformTool)
              entry.toolUses.set(update.toolCallId, { name: platformTool, args: input?.tool_input ?? {} });
          }

          for (const init of mapper.update(update)) await record(init);
        } else {
          for (const init of mapper.complete(event)) await record(init);

          if (event.stopReason === "cancelled") {
            outcome = TurnOutcome.INTERRUPTED;
            reason = "Grok cancelled the turn";
          } else if (["max_tokens", "max_turn_requests", "refusal"].includes(event.stopReason)) {
            outcome = TurnOutcome.FAILED;
            reason = `Grok stopped: ${event.stopReason}`;
            errorCode = classifyFailure(reason);
          }
        }
      }

      if (entry.interrupted) {
        outcome = TurnOutcome.INTERRUPTED;
        reason = "interrupted by the user";
      }
    } catch (error) {
      outcome = entry.interrupted ? TurnOutcome.INTERRUPTED : TurnOutcome.FAILED;
      reason = entry.interrupted
        ? "interrupted by the user"
        : safeFailureDetail(error instanceof Error ? error.message : "Grok CLI failed");
      errorCode = entry.interrupted ? "" : classifyFailure(reason);

      if (this.#entries.get(spec.threadId) === entry) this.#entries.delete(spec.threadId);
      await entry.dispose();
    } finally {
      for (const init of mapper.finish(
        outcome === TurnOutcome.COMPLETED ? ItemStatus.COMPLETED : ItemStatus.INTERRUPTED,
      ))
        await record(init);
      await record({
        turnId,
        body: {
          case: "turnFinished",
          value: {
            outcome,
            reason,
            errorCode,
            source: entry.interrupted ? TurnEndSource.USER : TurnEndSource.HARNESS,
            providerTurnRef: entry.session.sessionId,
            ...(mapper.usage.length === 1 && { usage: mapper.usage[0] }),
          },
        },
      });
      entry.turnId = "";

      if (this.#entries.get(spec.threadId) === entry) this.#idle(spec.threadId, entry);
    }
  }
  async interrupt(threadId: string, turnId: string): Promise<void> {
    const entry = this.#entries.get(threadId);

    if (!entry || entry.turnId !== turnId) throw new Error("Grok turn is not running");
    entry.interrupted = true;
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

            if (entry) entry.interrupted = true;
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
  #idle(threadId: string, entry: Entry): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (this.#entries.get(threadId) === entry && !entry.turnId) void this.unload(threadId);
    }, this.options.idleUnloadMs ?? 900_000);
    entry.idleTimer.unref();
  }
  async close(): Promise<void> {
    await Promise.all([...new Set([...this.#entries.keys(), ...this.#preparing.keys()])].map((id) => this.unload(id)));
  }
  async listModels(profileId: string): Promise<{ models: ModelInit[] }> {
    const profile = this.options.profile(profileId);

    if (!profile) throw new Error("Grok instance unavailable");

    const launch = grokLaunch({
      dataDir: this.options.dataDir,
      profile,
      executable: this.options.executable,
      linkDeviceLogin: this.options.linkDeviceLogin,
    });

    const client = new GrokClient(launch.options);

    try {
      const info = await client.initialize();
      const known = discoveredModels(info);

      if (profile.kind !== "cliproxyapi") return { models: known };
      const models = (await proxyModels(profile)).filter((m) => proxyModelFits("grok", m));

      return {
        models: models.map(
          (m) =>
            known.find((k) => k.id === m.id) ?? {
              id: m.id,
              displayName: m.displayName || concreteModelName(m.id),
              efforts: [],
              isDefault: false,
            },
        ),
      };
    } finally {
      await closeGrokResources([() => client.dispose(), launch.cleanup]);
    }
  }
}
