import { create, type JsonValue } from "@bufbuild/protobuf";
import {
  ConnectorToolSchema,
  connectors,
  ui,
  type AgentToolCall,
  type ConnectorTool,
  type ThreadEvent,
} from "@canopy/contracts";
import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits, type JsonObject } from "@canopy/domain";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore } from "../store/store.ts";
import { canonicalJson } from "../store/instance-config.ts";
import type { CoreRuntime } from "../core/core.ts";
import { mcpTools } from "../bots/mcp.ts";
import type { BotTurn, McpConnection, ToolSpec } from "../bots/types.ts";
import { connectorCatalog, connectorType } from "./catalog.ts";
import { completeOAuth } from "./oauth-completion.ts";
import {
  ConnectorFailure,
  digest,
  type AccountRow,
  type ConnectorStore,
  type Credentials,
  type ExecutionSource,
} from "./store.ts";
import { oauthEgress } from "./oauth-egress.ts";
import { OAuthNetworkFailure } from "./oauth-network.ts";
import { authorizeOAuth, redactConnector, revokeOAuth } from "./oauth.ts";
import { beginConnectorOAuth } from "./oauth-begin.ts";
import { slackUserCredentials } from "./slack-user-refresh.ts";
import type { SlackTransport } from "../messengers/slack-http.ts";
import { handleConnectorCall } from "./calls.ts";
import { executeConnector } from "./execute.ts";
import { connectorToolCatalog, SLACK_POST_ACTION, slackPostName } from "./slack-post-tool.ts";
import { supportsSlackDownload } from "./slack-download-tool.ts";
import { canDownloadSlackOnWorker } from "./slack-download.ts";
import { searchIssues } from "./issue-search.ts";
import { worktreeMerged } from "./merged-pr.ts";
import { connectorTestError, ConnectorTestFailure } from "./test-error.ts";

/** Catalog input schemas are stored as the JSON text of the object the MCP server sent. */
const inputSchema = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));

export class ConnectorsRuntime {
  readonly #active = new Map<string, { fingerprint: string; promise: Promise<JsonValue> }>();
  #stopped = false;
  constructor(
    private readonly options: {
      runtime: CoreRuntime;
      userId: string;
      messengerTransport?: SlackTransport;
      attachmentLimits?: () => Promise<AttachmentLimits>;
      log?: (message: string) => void;
      interaction(interaction: ui.Interaction): Promise<void>;
    },
  ) {}
  run<A, E, R extends never>(use: (store: ConnectorStore) => Effect.Effect<A, E, R>): Promise<A> {
    return this.options.runtime.runPromise(GatewayStore.use((s) => use(s.connectors)));
  }
  stop() {
    this.#stopped = true;
  }
  /** Gateway-owned cleanup read for a GitHub account granted to the worktree's project. */
  async worktreeMerged(
    userId: string,
    projectId: string,
    workerId: string,
    repository: string,
    branch: string,
    head: string,
  ) {
    if (userId !== this.options.userId || !projectId || !repository || !head) return false;

    return worktreeMerged(
      this,
      (user, id) => this.#connection(user, id),
      userId,
      projectId,
      workerId,
      repository,
      branch,
      head,
    );
  }
  searchIssues(request: ui.SearchIssuesRequest, signal: AbortSignal) {
    return searchIssues(this, (id) => this.#connection(this.options.userId, id), this.options.userId, request, signal);
  }

  async list(request: connectors.ListConnectorsRequest) {
    if (request.threadId && request.botId) throw new ConnectorFailure("Choose a thread or bot");
    const user = this.options.userId;

    const accounts = await this.run((s) =>
      Effect.gen(function* () {
        const rows = yield* s.list(
          user,
          {
            ...(request.threadId && { threadId: request.threadId }),
            ...(request.botId && { botId: request.botId }),
          },
          true,
        );

        return yield* s.views(rows);
      }),
    );

    const apps = await this.run((s) => s.appTypes(this.options.userId));

    return create(connectors.ListConnectorsResponseSchema, { types: connectorCatalog(apps), accounts });
  }
  save(
    request: connectors.SaveConnectorAccountRequest,
    receipt?: (sql: SqlClient.SqlClient, account: connectors.ConnectorAccount) => Effect.Effect<void>,
  ) {
    return this.run((s) => s.save(this.options.userId, request, receipt));
  }
  access(request: connectors.SetConnectorAccessRequest) {
    return this.run((s) => s.access(this.options.userId, request));
  }
  saveApp(request: connectors.SaveConnectorOAuthAppRequest) {
    return this.run((s) => s.saveApp(this.options.userId, request));
  }
  begin(request: connectors.BeginConnectorOAuthRequest) {
    return beginConnectorOAuth(this, this.options.userId, request, this.options);
  }
  async complete(input: connectors.CompleteConnectorOAuthRequest) {
    return completeOAuth(this, this.options.userId, input, this.options.messengerTransport);
  }
  /** Lock covers rotated refresh tokens across processes; no vendor request starts with stale credentials. */
  async #connection(
    user: string,
    id: string,
    testing = false,
  ): Promise<{ row: AccountRow; value: Credentials; server: McpConnection }> {
    const account = await this.run((s) => s.owned(user, id));

    const result =
      account.connector_type === "slack" && account.auth_kind === "oauth"
        ? await slackUserCredentials(this.options.runtime, user, id, testing)
        : await this.run((s) =>
            s.transaction(
              Effect.gen(function* () {
                const row = yield* s.owned(user, id, true);

                // Authentication may change after the initial read; Slack refresh must always commit its claim first.
                if (row.connector_type === "slack" && row.auth_kind === "oauth")
                  return yield* Effect.fail(new ConnectorFailure("Connector changed; try again"));

                if (row.status !== "connected" && !(testing && row.status === "error"))
                  return yield* Effect.fail(new ConnectorFailure("Connector needs reconnect or is disconnected"));
                const value = yield* s.credentials(row);

                if (
                  row.auth_kind === "oauth" &&
                  (!value.tokens || (value.expiresAt !== undefined && value.expiresAt <= Date.now() + 30_000))
                ) {
                  const app = yield* s.app(user, row.connector_type);

                  const refreshed = yield* Effect.tryPromise({
                    try: async () => {
                      if (!value.tokens?.refresh_token) return false;
                      const egress = oauthEgress(row.url, app?.issuer, { publicOrigins: value.oauthPublicOrigins });
                      const redirect = await authorizeOAuth(row, egress, value, "");

                      return !redirect && !!value.tokens;
                    },
                    catch: (cause) => (cause instanceof OAuthNetworkFailure ? cause : false),
                  }).pipe(Effect.catch(Effect.succeed));

                  if (refreshed !== true) {
                    yield* s.status(row, "needs_reconnect");

                    return refreshed || undefined;
                  }

                  yield* s.updateCredentials(row, value);
                }

                return { row, value };
              }),
            ),
          );

    if (result instanceof OAuthNetworkFailure) throw result;

    if (!result) throw new ConnectorFailure("Connector needs reconnect");
    const { row, value } = result;

    const headers = {
      ...value.headers,
      ...(value.tokens && { Authorization: `Bearer ${value.tokens.access_token}` }),
    };

    return {
      row,
      value,
      server: {
        id: row.id,
        name: `${connectorType(row.connector_type)?.name ?? row.connector_type} · ${row.name}`,
        url: row.url,
        transport: row.transport,
        enabled: true,
        headers,
        namespace: row.namespace,
      },
    };
  }

  async test(
    id: string,
    user = this.options.userId,
  ): Promise<{ tools: ConnectorTool[]; account: connectors.ConnectorAccount }> {
    const connection = await this.#connection(user, id, true);

    try {
      const catalog = await mcpTools(connection.server, AbortSignal.timeout(20_000));

      const tools = catalog
        .filter(
          (tool) =>
            tool.remoteName !== SLACK_POST_ACTION &&
            (connection.row.connector_type !== "slack" || tool.name !== slackPostName(connection.row)) &&
            redactConnector(tool.remoteName ?? tool.name, connection.value) === (tool.remoteName ?? tool.name) &&
            redactConnector(tool.name, connection.value) === tool.name,
        )
        .map((tool) =>
          create(ConnectorToolSchema, {
            accountId: id,
            connectorType: connection.row.connector_type,
            accountName: connection.row.name,
            name: tool.name,
            remoteName: tool.remoteName ?? tool.name,
            description: redactConnector(tool.description, connection.value),
            inputSchemaJson: redactConnector(JSON.stringify(tool.parameters), connection.value),
            readOnly: tool.readOnly === true,
          }),
        );

      await this.run((s) => s.saveTools(connection.row, tools));

      return { tools, account: await this.run((s) => s.owned(user, id).pipe(Effect.flatMap(s.view))) };
    } catch (cause) {
      const error = connectorTestError(cause, connection.row.connector_type, connection.value);
      console.warn(`Connector test failed (${connection.row.id}): ${error.detail}`);
      await this.run((s) => s.status(connection.row, "error", error));
      const account = await this.run((s) => s.owned(user, id).pipe(Effect.flatMap(s.view)));
      throw new ConnectorTestFailure(account, error.message);
    }
  }
  async tools(
    user: string,
    scope: { projectId: string; workerId: string } | { botId: string },
    includeSlackPost = true,
    includeSlackDownload = true,
  ): Promise<ConnectorTool[]> {
    const rows = await this.run((s) => s.list(user, scope));
    const tools: ConnectorTool[] = [];

    const workerId = "workerId" in scope ? scope.workerId : undefined;

    const download =
      includeSlackDownload &&
      rows.some(supportsSlackDownload) &&
      (!workerId ||
        (await this.options.runtime.runPromise(
          SqlClient.SqlClient.use((sql) => canDownloadSlackOnWorker(sql, workerId)),
        )));

    for (const row of rows) {
      if (row.status !== "connected" && row.status !== "error") continue;
      let catalog = await this.run((s) => Effect.succeed(s.tools(row)));

      // A failed test suspends tools until a fresh listing succeeds, including cached catalogs.
      if (row.status === "error" || !catalog.length) {
        try {
          catalog = (await this.test(row.id, user)).tools;
        } catch {
          continue;
        }
      }

      const post =
        includeSlackPost && row.connector_type === "slack" && (await this.run((s) => s.slackMessagingConnected(row)));

      tools.push(...connectorToolCatalog(row, catalog, post, download));
    }

    // A bounded prompt; account catalog pages are separately capped at 256.
    return tools.slice(0, 256);
  }
  async botTools(botId: string, turn?: BotTurn, filesEnabled = true): Promise<ToolSpec[]> {
    const allowSlackPost =
      !!turn && !turn.conversation_id && !turn.exchange_id && !turn.reply_to_bot_id && !turn.remote_recipient_ref;

    const tools = await this.tools(this.options.userId, { botId }, allowSlackPost, filesEnabled);

    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: inputSchema(t.inputSchemaJson),
      source: "mcp",
      serverId: t.accountId,
      serverName: `${connectorType(t.connectorType)?.name ?? t.connectorType} · ${t.accountName}`,
      remoteName: t.remoteName,
      readOnly: t.readOnly,
    }));
  }
  /** Canonical timeline labels come from owned accounts, never from worker-supplied metadata. */
  async enrich(events: ThreadEvent[]) {
    const catalogs = new Map<string, readonly AccountRow[]>();

    for (const event of events) {
      const body = event.body;
      const item = body.case === "itemStarted" || body.case === "itemCompleted" ? body.value.item : undefined;

      if (item?.content.case !== "toolCall") continue;
      const call = item.content.value;
      let catalog = catalogs.get(event.threadId);

      if (!catalog) {
        const thread = await this.options.runtime.runPromise(
          GatewayStore.use((s) => s.thread(event.threadId, true, true)),
        );

        // Deleted journals are resolved by ingest; missing labels must not prevent their ACK policy.
        if (thread.deleted_at) continue;
        catalog = await this.run((s) => s.list(thread.owner_user_id)).catch(() => []);
        catalogs.set(event.threadId, catalog);
      }

      // Preserve attribution after a grant was removed or the account disconnected.
      const found = catalog.find((row) => call.name.startsWith(`${row.namespace.slice(0, 39)}__`));
      call.connectorAccountId = found?.id ?? "";
      call.connectorType = found?.connector_type ?? "";
      call.connectorAccountName = found?.name ?? "";

      if (found) call.server = connectorType(found.connector_type)?.name ?? found.connector_type;
    }
  }
  async disconnect(id: string) {
    const { value, account, row } = await this.run((s) => s.disconnect(this.options.userId, id));
    const app = await this.run((s) => s.app(this.options.userId, row.connector_type));

    const revoked = await revokeOAuth(
      value,
      oauthEgress(row.url, app?.issuer, { publicOrigins: value.oauthPublicOrigins }),
    );

    await this.run((s) =>
      s.audit({ userId: this.options.userId, accountId: id }, "revoke", revoked ? "revoked" : "local_only"),
    );

    return account;
  }
  /** "changed" when `expectedRevision` no longer matches (the account stays). */
  async remove(
    id: string,
    options?: {
      readonly expectedRevision?: bigint;
      readonly receipt?: (sql: SqlClient.SqlClient) => Effect.Effect<void>;
      readonly changedReceipt?: (sql: SqlClient.SqlClient) => Effect.Effect<void>;
    },
  ) {
    return this.run((s) => s.remove(this.options.userId, id, options));
  }
  async call(
    source: ExecutionSource,
    callId: string,
    toolName: string,
    args: JsonObject,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    // Authorization precedes even replay lookup, so a revoked account cannot disclose old results.
    const account = await this.run((s) => s.authorize(source));
    const { botLease: _botLease, ...identity } = source;
    const legacyFingerprint = digest(JSON.stringify([identity, toolName, args]));
    const fingerprint = digest(canonicalJson([identity, toolName, args]));
    const active = this.#active.get(callId);

    if (active) {
      if (active.fingerprint !== fingerprint) throw new ConnectorFailure("Connector call identity mismatch");

      return active.promise;
    }

    const promise = executeConnector(
      {
        runtime: this.options.runtime,
        messengerTransport: this.options.messengerTransport,
        attachmentLimits: this.options.attachmentLimits ?? (async () => DEFAULT_ATTACHMENT_LIMITS),
        run: (use) => this.run(use),
        interaction: (interaction) => this.options.interaction(interaction),
        stopped: () => this.#stopped,
        catalog: async (user, id) => (await this.test(id, user)).tools,
        connection: (user, id) => this.#connection(user, id),
      },
      source,
      account,
      callId,
      toolName,
      args,
      fingerprint,
      legacyFingerprint,
      signal,
    );

    this.#active.set(callId, { fingerprint, promise });

    try {
      return await promise;
    } finally {
      this.#active.delete(callId);
    }
  }
  handle(request: AgentToolCall, workerId: string) {
    return handleConnectorCall(
      {
        runtime: this.options.runtime,
        run: (use) => this.run(use),
        call: (...input) => this.call(...input),
        log: this.options.log,
      },
      request,
      workerId,
    );
  }
}
