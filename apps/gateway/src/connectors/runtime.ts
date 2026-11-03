import { create, type JsonValue } from "@bufbuild/protobuf";
import { AgentToolResultSchema, ConnectorToolSchema, connectors, InteractionKind, InteractionRequestSchema, ui, type AgentToolCall, type ConnectorTool, type ThreadEvent } from "@canopy/contracts";
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { GatewayStore } from "../store/store.ts";
import type { CoreRuntime } from "../core/core.ts";
import { mcpCall, mcpTools } from "../bots/mcp.ts";
import type { McpConnection, ToolSpec } from "../bots/types.ts";
import { CONNECTOR_TYPES, connectorType, connectorUrl } from "./catalog.ts";
import { ConnectorFailure, digest, type AccountRow, type ConnectorStore, type Credentials, type ExecutionSource } from "./store.ts";
import { authorizeOAuth, redactConnector, revokeOAuth } from "./oauth.ts";

export class ConnectorsRuntime {
  readonly #active = new Map<string, { fingerprint: string; promise: Promise<JsonValue> }>();
  #stopped = false;
  constructor(private readonly options: {
    runtime: CoreRuntime; userId: string;
    interaction(interaction: ui.Interaction): Promise<void>;
  }) {}
  run<A, E, R extends never>(use: (store: ConnectorStore) => Effect.Effect<A, E, R>): Promise<A> {
    return this.options.runtime.runPromise(GatewayStore.use((s) => use(s.connectors)));
  }
  stop() { this.#stopped = true; }
  async list(request: connectors.ListConnectorsRequest) {
    if (request.threadId && request.botId) throw new ConnectorFailure("Choose a thread or bot");
    const user = this.options.userId;
    const accounts = await this.run((s) => Effect.gen(function* () {
      const rows = yield* s.list(user, { ...(request.threadId && { threadId: request.threadId }), ...(request.botId && { botId: request.botId }) });
      return yield* Effect.forEach(rows, s.view);
    }));
    const apps = await this.run((s) => s.appTypes(this.options.userId));
    return create(connectors.ListConnectorsResponseSchema, { types: CONNECTOR_TYPES.map((t) => ({ ...t, oauthAppSet: apps.includes(t.id) })), accounts });
  }
  save(request: connectors.SaveConnectorAccountRequest) { return this.run((s) => s.save(this.options.userId, request)); }
  access(request: connectors.SetConnectorAccessRequest) { return this.run((s) => s.access(this.options.userId, request)); }
  saveApp(request: connectors.SaveConnectorOAuthAppRequest) { return this.run((s) => s.saveApp(this.options.userId, request)); }
  async begin(request: connectors.BeginConnectorOAuthRequest) {
    if (!/^[\w-]{32,128}$/.test(request.browserBinding) || request.scope.length > 4000) throw new ConnectorFailure("Invalid OAuth session");
    const redirect = connectorUrl(request.redirectUri);
    if (new URL(redirect).pathname !== "/api/connectors/oauth/callback") throw new ConnectorFailure("Invalid OAuth callback");
    const row = await this.run((s) => s.owned(this.options.userId, request.accountId));
    if (row.auth_kind !== "oauth") throw new ConnectorFailure("This account uses token authentication");
    const app = await this.run((s) => s.app(this.options.userId, row.connector_type));
    const state = randomBytes(32).toString("base64url");
    const value: Credentials = { redirectUri: redirect, ...(app && { client: app }) };
    try {
      const url = await authorizeOAuth(row.url, value, state, request.scope || undefined);
      if (!url || !value.verifier) throw new Error("Authorization redirect missing");
      const authorization = new URL(url);
      connectorUrl(`${authorization.origin}${authorization.pathname}`);
      // SDK discovery must advertise S256; never accept a downgraded PKCE flow.
      if (authorization.searchParams.get("code_challenge_method") !== "S256") throw new Error("PKCE required");
      await this.run((s) => s.saveState(this.options.userId, row, state, request.browserBinding, value));
      return create(connectors.BeginConnectorOAuthResponseSchema, { authorizationUrl: url });
    } catch { throw new ConnectorFailure("Could not start OAuth. Check the server metadata and registered OAuth app."); }
  }
  async complete(request: connectors.CompleteConnectorOAuthRequest) {
    if (!/^[\w-]{32,128}$/.test(request.state) || !/^[\w-]{32,128}$/.test(request.browserBinding) || request.code.length > 8000) throw new ConnectorFailure("Invalid OAuth session");
    const session = await this.run((s) => s.consumeState(this.options.userId, request.state, request.browserBinding)).catch(() => { throw new ConnectorFailure('OAuth session is invalid, expired or already used. Start sign-in again.'); });
    if (request.error || !request.code) throw new ConnectorFailure("Authorization was declined. Reconnect when ready.");
    try {
      const user = this.options.userId;
      return await this.run((s) => s.transaction(Effect.gen(function* () {
        const row = yield* s.owned(user, session.accountId, true);
        if (BigInt(row.revision) !== session.revision) return yield* Effect.fail(new ConnectorFailure("Connector changed. Reconnect again."));
        const issuer = session.value.discovery?.authorizationServerMetadata?.issuer;
        if (request.issuer && request.issuer !== issuer) return yield* Effect.fail(new ConnectorFailure("OAuth issuer mismatch"));
        yield* Effect.tryPromise({ try: () => authorizeOAuth(row.url, session.value, request.state, undefined, request.code), catch: () => new ConnectorFailure("Could not finish authorization. Reconnect again.") });
        delete session.value.verifier;
        yield* s.updateCredentials(row, session.value, "connected");
        yield* s.audit({ userId: user, accountId: row.id }, "oauth", "connected");
        return yield* s.view(yield* s.owned(user, row.id));
      })));
    } catch { throw new ConnectorFailure("Could not finish authorization. Reconnect again."); }
  }
  /** Lock covers rotated refresh tokens across processes; no vendor request starts with stale credentials. */
  async #connection(user: string, id: string, testing = false): Promise<{ row: AccountRow; value: Credentials; server: McpConnection }> {
    const result = await this.run((s) => s.transaction(Effect.gen(function* () {
      const row = yield* s.owned(user, id, true);
      if (row.status !== "connected" && !(testing && row.status === "error")) return yield* Effect.fail(new ConnectorFailure("Connector needs reconnect or is disconnected"));
      const value = yield* s.credentials(row);
      if (row.auth_kind === "oauth" && (!value.tokens || value.expiresAt !== undefined && value.expiresAt <= Date.now() + 30_000)) {
        const refreshed = yield* Effect.tryPromise({ try: async () => {
          if (!value.tokens?.refresh_token) return false;
          const redirect = await authorizeOAuth(row.url, value, "", undefined);
          return !redirect && !!value.tokens;
        }, catch: () => new ConnectorFailure("Connector needs reconnect") }).pipe(Effect.catch(() => Effect.succeed(false)));
        if (!refreshed) { yield* s.status(row, "needs_reconnect"); return undefined; }
        yield* s.updateCredentials(row, value);
      }
      const headers = { ...value.headers, ...(value.tokens && { Authorization: `Bearer ${value.tokens.access_token}` }) };
      return { row, value, server: { id: row.id, name: `${connectorType(row.connector_type)?.name ?? row.connector_type} · ${row.name}`, url: row.url, transport: row.transport, enabled: true, headers, namespace: row.namespace } };
    })));
    if (!result) throw new ConnectorFailure("Connector needs reconnect");
    return result;
  }
  async test(id: string, user = this.options.userId): Promise<{ tools: ConnectorTool[]; account: connectors.ConnectorAccount }> {
    const connection = await this.#connection(user, id, true);
    try {
      const catalog = await mcpTools(connection.server, AbortSignal.timeout(20_000));
      const tools = catalog.filter((tool) => redactConnector(tool.remoteName ?? tool.name, connection.value) === (tool.remoteName ?? tool.name) && redactConnector(tool.name, connection.value) === tool.name).map((tool) => create(ConnectorToolSchema, { accountId: id, connectorType: connection.row.connector_type, accountName: connection.row.name,
        name: tool.name, remoteName: tool.remoteName ?? tool.name, description: redactConnector(tool.description, connection.value),
        inputSchemaJson: redactConnector(JSON.stringify(tool.parameters), connection.value), readOnly: tool.readOnly === true }));
      await this.run((s) => s.saveTools(connection.row, tools));
      return { tools, account: await this.run((s) => s.owned(user, id).pipe(Effect.flatMap(s.view))) };
    } catch {
      await this.run((s) => s.status(connection.row, "error"));
      throw new ConnectorFailure("Connection failed. Check the endpoint and reconnect the account.");
    }
  }
  async tools(user: string, scope: { workerId?: string; botId?: string }): Promise<ConnectorTool[]> {
    const rows = await this.run((s) => s.list(user, scope));
    const tools: ConnectorTool[] = [];
    for (const row of rows) {
      if (row.status !== "connected") continue;
      let catalog = await this.run((s) => Effect.succeed(s.tools(row)));
      if (!catalog.length) {
        try { catalog = (await this.test(row.id, user)).tools; } catch { continue; }
      }
      tools.push(...catalog.map((t) => ({ ...t, accountName: row.name })));
    }
    // A bounded prompt; account catalog pages are separately capped at 256.
    return tools.slice(0, 256);
  }
  async botTools(botId: string): Promise<ToolSpec[]> {
    return (await this.tools(this.options.userId, { botId })).map((t) => ({ name: t.name, description: t.description,
      parameters: JSON.parse(t.inputSchemaJson) as Record<string, unknown>, source: "mcp", serverId: t.accountId,
      serverName: `${connectorType(t.connectorType)?.name ?? t.connectorType} · ${t.accountName}`, remoteName: t.remoteName, readOnly: t.readOnly }));
  }
  /** Canonical timeline labels come from owned accounts, never from worker-supplied metadata. */
  async enrich(events: ThreadEvent[]) {
    const catalogs = new Map<string, readonly AccountRow[]>();
    for (const event of events) {
      const body = event.body;
      const item = body.case === 'itemStarted' || body.case === 'itemCompleted' ? body.value.item : undefined;
      if (item?.content.case !== 'toolCall') continue;
      const call = item.content.value;
      let catalog = catalogs.get(event.threadId);
      if (!catalog) {
        const thread = await this.options.runtime.runPromise(GatewayStore.use((s) => s.thread(event.threadId)));
        catalog = await this.run((s) => s.list(thread.owner_user_id)).catch(() => []);
        catalogs.set(event.threadId, catalog);
      }
      // Preserve attribution after a grant was removed or the account disconnected.
      const found = catalog.find((row) => call.name.startsWith(`${row.namespace.slice(0,39)}__`));
      call.connectorAccountId = found?.id ?? '';
      call.connectorType = found?.connector_type ?? '';
      call.connectorAccountName = found?.name ?? '';
      if (found) call.server = connectorType(found.connector_type)?.name ?? found.connector_type;
    }
  }
  async disconnect(id: string) {
    const { value, account } = await this.run((s) => s.disconnect(this.options.userId, id));
    const revoked = await revokeOAuth(value);
    await this.run((s) => s.audit({ userId: this.options.userId, accountId: id }, "revoke", revoked ? "revoked" : "local_only"));
    return account;
  }
  async remove(id: string) {
    const account = await this.run((s) => s.owned(this.options.userId, id));
    if (account.status !== "disconnected") await this.disconnect(id);
    await this.run((s) => s.remove(this.options.userId, id));
  }
  async call(source: ExecutionSource, callId: string, toolName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<JsonValue> {
    // Authorization precedes even replay lookup, so a revoked account cannot disclose old results.
    await this.run((s) => s.authorize(source));
    const fingerprint = digest(JSON.stringify([source, toolName, args]));
    const active = this.#active.get(callId);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new ConnectorFailure("Connector call identity mismatch");
      return active.promise;
    }
    const promise = this.#execute(source, callId, toolName, args, fingerprint, signal);
    this.#active.set(callId, { fingerprint, promise });
    try { return await promise; } finally { this.#active.delete(callId); }
  }
  async #execute(source: ExecutionSource, callId: string, toolName: string, args: Record<string, unknown>, fingerprint: string, signal: AbortSignal): Promise<JsonValue> {
    const old = await this.run((s) => s.execution(callId));
    if (old) {
      if (old.fingerprint !== fingerprint) throw new ConnectorFailure("Connector call identity mismatch");
      return old.result ?? { isError: true, content: [{ type: "text", text: "Outcome unknown after disconnect. Do not repeat a write without user confirmation." }] };
    }
    // Fresh annotations are authoritative for approval, never the worker's descriptor.
    const catalog = await this.test(source.accountId, source.userId);
    const tool = catalog.tools.find((t) => t.name === toolName);
    if (!tool) throw new ConnectorFailure("Connector tool is unavailable");
    if (source.botId && source.readOnlyOnly && !tool.readOnly) throw new ConnectorFailure("The connector tool now requires approval. Ask the user before retrying.");
    if (source.threadId) await this.#permission(source, callId, tool, args, signal);
    const current = await this.run((s) => s.authorize(source));
    const connection = await this.#connection(source.userId, source.accountId);
    if (BigInt(current.revision) !== BigInt(connection.row.revision)) throw new ConnectorFailure("Connector changed; try again");
    const claimed = await this.run((s) => s.claimExecution(callId, source, tool.remoteName, fingerprint));
    if (!claimed) throw new ConnectorFailure("Connector call already started; outcome unknown. Do not repeat writes.");
    let result: JsonValue;
    try {
      const output = await mcpCall(connection.server, { name: tool.name, description: tool.description, parameters: {}, source: "mcp", remoteName: tool.remoteName }, args, signal);
      result = JSON.parse(redactConnector(JSON.stringify(output), connection.value)) as JsonValue;
    } catch { result = { isError: true, content: [{ type: "text", text: "Connector call interrupted or failed; outcome may be unknown. Do not automatically retry writes." }] }; }
    const isError = !!(result && typeof result === "object" && !Array.isArray(result) && result["isError"]);
    await this.run((s) => s.finishExecution(callId, source, tool.remoteName, result, isError));
    return result;
  }
  async #permission(source: ExecutionSource, callId: string, tool: ConnectorTool, args: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const facts = await this.options.runtime.runPromise(GatewayStore.use((s) => Effect.gen(function* () {
      const thread = yield* s.thread(source.threadId!);
      const turn = yield* s.runningTurn(thread.id);
      if (!turn || source.turnId !== turn.id) return yield* Effect.fail(new ConnectorFailure("Connector call requires the active turn"));
      return { mode: turn.permission_mode || thread.settings.permissionMode || "ASK", turnId: turn.id };
    })));
    if (tool.readOnly) return;
    if (facts.mode === "READ_ONLY") throw new ConnectorFailure("Read-only threads cannot call connector tools that may write");
    if (facts.mode === "FULL_AUTO") return;
    const credentials = await this.run((s) => s.owned(source.userId, source.accountId).pipe(Effect.flatMap(s.credentials)));
    const interaction = await this.options.runtime.runPromise(GatewayStore.use((s) => s.recordInteraction(create(InteractionRequestSchema, { requestId: callId,
      threadId: source.threadId!, turnId: facts.turnId, itemId: callId, kind: InteractionKind.PERMISSION, toolName: tool.name,
      requestJson: redactConnector(JSON.stringify({ tool_name: `${connectorType(tool.connectorType)?.name} · ${tool.accountName} · ${tool.remoteName}`, description: "Allow this connector action?", connector_account_id: tool.accountId, input: args }), credentials),
    }))));
    await this.options.interaction(interaction);
    for (;;) {
      signal.throwIfAborted();
      if (this.#stopped) throw new ConnectorFailure("Gateway stopped");
      const answer = await this.options.runtime.runPromise(GatewayStore.use((s) => s.interactionAnswer(callId)));
      if (answer) {
        if (!answer.answer.allow || answer.answer.cancelled) throw new ConnectorFailure("The user declined this connector action. Do not retry it.");
        return;
      }
      const running = await this.options.runtime.runPromise(GatewayStore.use((s) => s.runningTurn(source.threadId!)));
      if (running?.id !== facts.turnId) throw new ConnectorFailure("The turn ended before connector approval");
      await Bun.sleep(250);
    }
  }
  async handle(request: AgentToolCall, workerId: string) {
    let source: ExecutionSource | undefined;
    try {
      if (!request.connectorAccountId || request.argumentsJson.length > 100_000) throw new ConnectorFailure("Invalid connector call");
      const thread = await this.options.runtime.runPromise(GatewayStore.use((s) => s.thread(request.threadId)));
      if (thread.worker_id !== workerId) throw new ConnectorFailure("Connector access denied");
      source = { userId: thread.owner_user_id, accountId: request.connectorAccountId, workerId, threadId: thread.id, turnId: request.turnId };
      const args: unknown = JSON.parse(request.argumentsJson);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new ConnectorFailure("Invalid connector arguments");
      const result = await this.call(source, request.callId, request.toolName, args as Record<string, unknown>, AbortSignal.timeout(300_000));
      const isError = !!(result && typeof result === "object" && !Array.isArray(result) && result["isError"]);
      return create(AgentToolResultSchema, { callId: request.callId, isError, content: JSON.stringify(result), resultJson: JSON.stringify(result) });
    } catch {
      if (source) await this.run((s) => s.audit(source!, request.toolName, "denied_or_failed")).catch(() => undefined);
      const message = "Connector call refused or failed. Check account access, connection status, permission mode and approval. No automatic write retry.";
      return create(AgentToolResultSchema, { callId: request.callId, isError: true, content: message, resultJson: JSON.stringify({ error: message }) });
    }
  }
}
