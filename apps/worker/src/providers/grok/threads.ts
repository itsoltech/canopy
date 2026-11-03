import { create } from "@bufbuild/protobuf";
import { readFile } from "node:fs/promises";
import { GrokClient, type Content, type PermissionRequest, type PermissionResult, type SessionResult } from "@canopy/grok-acp";
import { InteractionKind, InteractionRequestSchema, ItemStatus, PermissionMode, TurnEndSource, TurnOutcome, type AgentToolCall, type AgentToolResult, type ForkSpec, type InteractionRequest, type InteractionResponse, type ThreadEvent, type ThreadSpec, type UserInput } from "@canopy/contracts";
import type { ThreadEventInit } from "../../journal/index.ts";
import type { ViewImageResult } from "../../images/index.ts";
import { isAgentModel, proxyModels, type ModelInit } from "../models.ts";
import type { ResolvedProfile } from "../profiles.ts";
import type { TurnSettings } from "../turn-input.ts";
import { grokLaunch } from "./launch.ts";
import { grokBus } from "./bus.ts";
import { GrokEventMapper } from "./mapping.ts";

interface Options {
  dataDir: string;
  executable: string;
  linkDeviceLogin: boolean;
  idleUnloadMs?: number;
  profile(id: string): ResolvedProfile | undefined;
  record(threadId: string, init: ThreadEventInit): Promise<ThreadEvent>;
  interact(request: InteractionRequest, signal?: AbortSignal): Promise<InteractionResponse>;
  callTool(call: AgentToolCall): Promise<AgentToolResult>;
  viewImage?(threadId: string, cwd: string, path: string): Promise<ViewImageResult>;
}
interface Entry {
  client: GrokClient; session: SessionResult; dispose(): Promise<void>; turnId: string; mode: PermissionMode;
  interrupted: boolean; settings: string;
  toolUses: Map<string, { name: string; args: unknown }>;
  approvals: Set<string>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

// ACP metadata from Grok lists the highest effort first; composers expect lowest first.
const effortRank: Readonly<Record<string, number>> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, ultra: 7 };

/** Worker registry with the same lifecycle operations as ClaudeThreads/CodexThreads; one ACP process per thread. */
export class GrokThreads {
  readonly #entries = new Map<string, Entry>();
  constructor(readonly options: Options) {}
  running(threadId: string): boolean { return !!this.#entries.get(threadId)?.turnId; }
  async create(spec: ThreadSpec, fork?: ForkSpec): Promise<string> {
    if (fork) throw new Error("Grok ACP does not expose session fork");
    const entry = await this.#open(spec);
    await this.options.record(spec.threadId, { body: { case: "threadReady", value: { providerThreadId: entry.session.sessionId } } });
    this.#idle(spec.threadId, entry);
    return entry.session.sessionId;
  }
  async #open(spec: ThreadSpec, settings?: TurnSettings): Promise<Entry> {
    const profile = this.options.profile(spec.providerProfileId);
    if (!profile) throw new Error("Grok provider instance unavailable");
    const chosen = { model: settings?.model || spec.model, effort: settings?.effort || "", permissionMode: settings?.permissionMode || spec.permissionMode };
    const key = JSON.stringify({ ...chosen, connectorTools: spec.connectorTools });
    const previous = this.#entries.get(spec.threadId);
    if (previous?.turnId) throw new Error("Grok turn already running");
    if (previous?.settings === key && !previous.client.closed) { clearTimeout(previous.idleTimer); return previous; }
    const sessionId = previous?.session.sessionId || spec.providerThreadId;
    if (previous) { this.#entries.delete(spec.threadId); await previous.dispose(); }
    const launch = grokLaunch({ dataDir: this.options.dataDir, profile, executable: this.options.executable, model: chosen.model, effort: chosen.effort, readOnly: chosen.permissionMode === PermissionMode.READ_ONLY, fullAuto: chosen.permissionMode === PermissionMode.FULL_AUTO, linkDeviceLogin: this.options.linkDeviceLogin });
    let entry: Entry | undefined;
    const bus = grokBus({ threadId: spec.threadId, depth: spec.depth, agentBus: spec.enableAgentBus, turnId: () => entry?.turnId ?? "", callTool: this.options.callTool,
      connectorTools: spec.connectorTools,
      record: (event) => this.options.record(spec.threadId, event),
      ...(this.options.viewImage && { viewImage: (path: string) => this.options.viewImage!(spec.threadId, spec.cwd, path) }),
      toolUseId: (name, args) => {
        for (const [id, use] of entry?.toolUses ?? []) if (use.name === name && JSON.stringify(use.args) === JSON.stringify(args)) { entry?.toolUses.delete(id); return `${entry?.turnId}:${id}`; }
        return undefined;
      },
    });
    const client = new GrokClient({ ...launch.options, callbacks: { requestPermission: (request, signal) => this.#permission(spec, entry, request, signal) } });
    const dispose = async () => { clearTimeout(entry?.idleTimer); try { await client.dispose(); } finally { bus?.close(); launch.cleanup(); } };
    try {
      const info = await client.initialize();
      if (bus && !info.agentCapabilities?.mcpCapabilities?.http) throw new Error("Installed Grok lacks HTTP MCP support");
      const servers = bus ? [bus.server] : [];
      const session = sessionId ? await client.loadSession(sessionId, spec.cwd, servers) : await client.newSession(spec.cwd, servers);
      if (chosen.model && session.models && session.models.currentModelId !== chosen.model) await client.setModel(session.sessionId, chosen.model);
      entry = { client, session, dispose, turnId: "", mode: chosen.permissionMode, interrupted: false, settings: key, toolUses: new Map(), approvals: new Set() };
      this.#entries.set(spec.threadId, entry);
      return entry;
    } catch (error) { await dispose(); throw error; }
  }
  async #permission(spec: ThreadSpec, entry: Entry | undefined, request: PermissionRequest, signal: AbortSignal): Promise<PermissionResult> {
    const selected = (allow: boolean): PermissionResult => {
      const option = request.options.find((o) => o.kind === (allow ? "allow_once" : "reject_once")) ?? request.options.find((o) => o.kind === (allow ? "allow_always" : "reject_always"));
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    };
    if (!entry?.turnId || signal.aborted) return { outcome: { outcome: "cancelled" } };
    if (entry.mode === PermissionMode.READ_ONLY) return selected(false);
    if (entry.mode === PermissionMode.FULL_AUTO) return selected(true);
    if (entry.mode === PermissionMode.ACCEPT_EDITS && (request.toolCall.kind === "edit" || /^(write_file|edit_file|apply_patch|str_replace_editor)$/.test(request.toolCall.title ?? ""))) return selected(true);
    const approval = JSON.stringify([request.toolCall.title, request.toolCall.rawInput]);
    if (entry.approvals.has(approval)) return selected(true);
    const answer = await this.options.interact(create(InteractionRequestSchema, { requestId: crypto.randomUUID(), threadId: spec.threadId, turnId: entry.turnId,
      itemId: `${entry.turnId}:${request.toolCall.toolCallId}`, kind: InteractionKind.PERMISSION, toolName: request.toolCall.title ?? "Grok tool", requestJson: JSON.stringify({ input: request.toolCall.rawInput }) }), signal);
    if (answer.allow && answer.allowForSession && !signal.aborted) entry.approvals.add(approval);
    return signal.aborted || answer.cancelled ? { outcome: { outcome: "cancelled" } } : selected(answer.allow);
  }
  async startTurn(spec: ThreadSpec, turnId: string, input: UserInput, settings?: TurnSettings): Promise<void> {
    const entry = await this.#open(spec, settings);
    entry.turnId = turnId; entry.interrupted = false;
    entry.toolUses.clear();
    const mapper = new GrokEventMapper(turnId, spec.cwd);
    const record = (init: ThreadEventInit) => this.options.record(spec.threadId, init);
    await record({ turnId, body: { case: "turnStarted", value: { model: settings?.model || spec.model } } });
    await record({ turnId, body: { case: "itemCompleted", value: { item: { itemId: `${turnId}:input`, status: ItemStatus.COMPLETED, content: { case: "userMessage", value: { text: input.text, clientId: turnId, mentions: input.mentions } } } } } });
    let outcome = TurnOutcome.COMPLETED; let reason = "";
    try {
      const prompt: Content[] = [{ type: "text", text: [spec.instructions ? `Canopy thread instructions:\n${spec.instructions}` : "", input.text].filter(Boolean).join("\n\n") }];
      for (const attachment of input.attachments) {
        if (attachment.mimeType.startsWith("image/") && entry.client.capabilities?.agentCapabilities?.promptCapabilities?.image) {
          prompt.push({ type: "image", data: (await readFile(attachment.path)).toString("base64"), mimeType: attachment.mimeType });
        } else prompt.push({ type: "text", text: `Attachment: ${attachment.path}` });
      }
      for await (const event of entry.client.prompt(entry.session.sessionId, prompt)) {
        if (event.type === "update") {
          const update = event.update;
          if (update.sessionUpdate === "tool_call" && update.title === "use_tool") {
            const input = update.rawInput as { tool_name?: string; tool_input?: unknown } | undefined;
            if (input?.tool_name?.startsWith("openagents__")) entry.toolUses.set(update.toolCallId, { name: input.tool_name.slice("openagents__".length), args: input.tool_input ?? {} });
          }
          for (const init of mapper.update(update)) await record(init);
        }
        else if (event.stopReason === "cancelled") { outcome = TurnOutcome.INTERRUPTED; reason = "Grok cancelled the turn"; }
        else if (["max_tokens", "max_turn_requests", "refusal"].includes(event.stopReason)) { outcome = TurnOutcome.FAILED; reason = `Grok stopped: ${event.stopReason}`; }
      }
      if (entry.interrupted) { outcome = TurnOutcome.INTERRUPTED; reason = "interrupted by the user"; }
    } catch {
      outcome = entry.interrupted ? TurnOutcome.INTERRUPTED : TurnOutcome.FAILED;
      reason = entry.interrupted ? "interrupted by the user" : "Grok CLI failed; check authentication and provider configuration";
      this.#entries.delete(spec.threadId); await entry.dispose();
    } finally {
      for (const init of mapper.finish(outcome === TurnOutcome.COMPLETED ? ItemStatus.COMPLETED : ItemStatus.INTERRUPTED)) await record(init);
      await record({ turnId, body: { case: "turnFinished", value: { outcome, reason, source: entry.interrupted ? TurnEndSource.USER : TurnEndSource.HARNESS, providerTurnRef: entry.session.sessionId } } });
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
  async unload(threadId: string): Promise<void> { const entry = this.#entries.get(threadId); this.#entries.delete(threadId); await entry?.dispose(); }
  #idle(threadId: string, entry: Entry): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => { if (!entry.turnId) void this.unload(threadId); }, this.options.idleUnloadMs ?? 900_000);
    entry.idleTimer.unref();
  }
  async close(): Promise<void> { await Promise.all([...this.#entries.keys()].map((id) => this.unload(id))); }
  async listModels(profileId: string): Promise<{ models: ModelInit[] }> {
    const profile = this.options.profile(profileId);
    if (!profile) throw new Error("Grok instance unavailable");
    const launch = grokLaunch({ dataDir: this.options.dataDir, profile, executable: this.options.executable, linkDeviceLogin: this.options.linkDeviceLogin });
    const client = new GrokClient(launch.options);
    try {
      const info = await client.initialize();
      const state = (info as unknown as { _meta?: { modelState?: SessionResult["models"] } })._meta?.modelState;
      const known: ModelInit[] = (state?.availableModels ?? []).map((m) => {
        const meta = (m as unknown as { _meta?: { reasoningEfforts?: { id: string; default?: boolean }[] } })._meta;
        const efforts = (meta?.reasoningEfforts?.map((e) => e.id) ?? []).sort((a, b) => (effortRank[a] ?? 100) - (effortRank[b] ?? 100));
        return { id: m.modelId, displayName: m.name, description: m.description ?? "", isDefault: m.modelId === state?.currentModelId, efforts, defaultEffort: meta?.reasoningEfforts?.find((e) => e.default)?.id ?? "" };
      });
      if (profile.kind !== "cliproxyapi") return { models: known };
      const models = (await proxyModels(profile)).filter((m) => /grok/i.test(m.id) && isAgentModel([m.id], m));
      return { models: models.map((m) => known.find((k) => k.id === m.id) ?? { id: m.id, displayName: m.id, efforts: [], isDefault: false }) };
    } finally { await client.dispose(); launch.cleanup(); }
  }
}
