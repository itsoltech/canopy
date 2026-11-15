import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import {
  AgentTool,
  AgentToolsReportSchema,
  ui,
  type AgentToolProgress,
  type AgentToolsReport,
} from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { WorkerLink } from "../worker-link/index.ts";
import type { CoreRuntime, GatewayCore } from "./core.ts";
import { queryFamily, queryRpc } from "../diagnostics/query-context.ts";
import {
  AGENT_TOOLS as TOOLS,
  AGENT_WORKER_ID as UUID,
  agentToolWorkerId as workerId,
  validateAgentTool as validateTool,
  validateAgentToolOperation as validateOperation,
} from "./agent-tools-validation.ts";

export const AGENT_TOOL_LOG_LINES = 200;
const enabledOf = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Boolean));
const MAX_TEXT = 512 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;
const DEVICE_PREVIEW_VERSION = "0.21.37";

interface AgentToolRow {
  id: string;
  enabled: Readonly<Record<string, boolean>>;
  report: AgentToolsReport | undefined;
}

export interface AgentToolsOptions {
  readonly runtime: CoreRuntime;
  readonly userId: string;
  readonly link: WorkerLink;
  readonly changed: () => Promise<void>;
}

export class AgentTools {
  readonly #options: AgentToolsOptions;
  readonly #logs = new Map<string, string[]>();

  constructor(options: AgentToolsOptions) {
    this.#options = options;
  }

  #run<A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> {
    return this.#options.runtime.runPromise(effect.pipe(queryFamily("workers.store"), queryRpc));
  }

  #connection(id: string) {
    const connection = this.#options.link.connections.get(id);

    if (!connection?.isOpen) throw new ConnectError("the worker is offline", Code.Unavailable);

    if (!connection.hello.capabilities.includes("agent_tools_v1"))
      throw new ConnectError("update this worker to use automation tools", Code.FailedPrecondition);

    return connection;
  }

  #supported(id: string): boolean {
    const connection = this.#options.link.connections.get(id);

    return Boolean(connection?.isOpen && connection.hello.capabilities.includes("agent_tools_v1"));
  }

  async report(id: string, report: AgentToolsReport): Promise<void> {
    if (!UUID.test(id) || !this.#supported(id) || report.tools.length > TOOLS.size) return;

    if (
      report.tools.some((tool) => !TOOLS.has(tool.tool)) ||
      new Set(report.tools.map((tool) => tool.tool)).size !== report.tools.length
    )
      return;
    const json = JSON.stringify(toJson(AgentToolsReportSchema, report));

    if (Buffer.byteLength(json) > 64 * 1024) return;
    const userId = this.#options.userId;

    const rows = await this.#run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql`UPDATE workers SET capabilities = capabilities || jsonb_build_object('agentTools', ${json}::jsonb)
          WHERE id = ${id}::uuid AND owner_user_id = ${userId}::uuid AND archived_at IS NULL AND revoked_at IS NULL RETURNING id`;
      }),
    );

    if (rows.length) await this.#options.changed();
  }

  async progress(id: string, progress: AgentToolProgress): Promise<void> {
    if (!UUID.test(id) || !this.#supported(id) || !TOOLS.has(progress.tool)) return;
    const row = (await this.#rows([id])).get(id);
    const install = row?.report?.tools.find((tool) => tool.tool === progress.tool)?.install;

    if (!install || install.state !== "running" || install.installId !== progress.installId) return;
    const key = `${id}/${progress.tool}`;
    const lines = progress.lines.slice(-AGENT_TOOL_LOG_LINES).map((line) => line.slice(0, 1024));
    this.#logs.set(key, [...(this.#logs.get(key) ?? []), ...lines].slice(-AGENT_TOOL_LOG_LINES));
    await this.#options.changed();
  }

  async #rows(ids?: readonly string[]): Promise<Map<string, AgentToolRow>> {
    if (ids?.length === 0) return new Map();
    const userId = this.#options.userId;

    const workers = await this.#run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{ id: string; tools: JsonValue | null; enabled: JsonValue | null }>`
          SELECT id, capabilities->'agentTools' AS tools, capabilities->'agentToolsEnabled' AS enabled
          FROM workers WHERE owner_user_id = ${userId}::uuid AND archived_at IS NULL AND revoked_at IS NULL
          AND (${ids === undefined} OR id = ANY(${ids ?? []}::uuid[]))`;
      }),
    );

    return new Map(
      workers.map((worker) => {
        let report: AgentToolsReport | undefined;

        try {
          report = worker.tools
            ? fromJson(AgentToolsReportSchema, worker.tools, { ignoreUnknownFields: true })
            : undefined;
        } catch {
          report = undefined;
        }

        return [worker.id, { id: worker.id, report, enabled: Option.getOrElse(enabledOf(worker.enabled), () => ({})) }];
      }),
    );
  }

  async #owned(id: string): Promise<AgentToolRow> {
    const row = (await this.#rows([id])).get(id);

    if (!row) throw new ConnectError("worker not found", Code.NotFound);

    return row;
  }

  async decorate(workers: ui.Worker[]): Promise<void> {
    const rows = await this.#rows(workers.flatMap((worker) => (UUID.test(worker.id) ? [worker.id] : [])));

    for (const worker of workers) {
      const row = rows.get(worker.id);

      if (row?.report)
        worker.agentTools = row.report.tools.flatMap((tool) =>
          TOOLS.has(tool.tool) ? [this.#view(worker, row, tool)] : [],
        );
    }
  }

  /** An installed binary is available to agents only after the owner's explicit grant. */
  async readyTools(id: string): Promise<AgentTool[]> {
    if (!UUID.test(id) || !this.#supported(id)) return [];
    const row = (await this.#rows([id])).get(id);

    return (
      row?.report?.tools.flatMap((tool) =>
        TOOLS.has(tool.tool) && row.enabled[String(tool.tool)] && tool.installed && tool.ready ? [tool.tool] : [],
      ) ?? []
    );
  }

  async authorize(id: string, tool: AgentTool): Promise<void> {
    const row = await this.#owned(workerId(id));
    validateTool(tool);
    this.#connection(row.id);
    this.#authorize(row, tool);
  }

  /** Device discovery needs a pinned binary before a target can make doctor ready. */
  async authorizePreview(id: string, tool: AgentTool): Promise<void> {
    if (tool !== AgentTool.DEVICE) return this.authorize(id, tool);
    const row = await this.#owned(workerId(id));
    this.#connection(row.id);

    if (!row.enabled[String(tool)])
      throw new ConnectError("enable this automation tool on the worker first", Code.PermissionDenied);
    const info = row.report?.tools.find((item) => item.tool === tool);

    if (!info?.installed || info.version !== DEVICE_PREVIEW_VERSION || info.install?.state === "running")
      throw new ConnectError(
        "install the pinned agent-device version before opening its preview",
        Code.FailedPrecondition,
      );
  }

  #authorize(row: AgentToolRow, tool: AgentTool) {
    if (!row.enabled[String(tool)])
      throw new ConnectError("enable this automation tool on the worker first", Code.PermissionDenied);
    const info = row.report?.tools.find((item) => item.tool === tool);

    if (!info?.installed || !info.ready)
      throw new ConnectError("automation tool is not ready", Code.FailedPrecondition);

    return info;
  }

  #view(worker: ui.Worker, row: AgentToolRow, tool: AgentToolsReport["tools"][number]): ui.WorkerAgentTool {
    const canInstall = tool.installable && (!tool.installed || !tool.ready);

    const blockedReason = !worker.online
      ? "The worker is offline"
      : !this.#supported(worker.id)
        ? "Update this worker to manage automation tools from Canopy"
        : tool.install?.state === "running"
          ? "Installing…"
          : "";

    return create(ui.WorkerAgentToolSchema, {
      tool,
      enabled: row.enabled[String(tool.tool)] === true,
      action: canInstall && !blockedReason ? "install" : "",
      blockedReason,
      log: this.#logs.get(`${worker.id}/${tool.tool}`) ?? [],
    });
  }

  async setEnabled(request: ui.SetAgentToolEnabledRequest): Promise<ui.WorkerOperationResponse> {
    const row = await this.#owned(workerId(request.workerId));
    validateTool(request.tool);

    if (request.enabled) this.#connection(row.id);
    const userId = this.#options.userId;
    const key = String(request.tool);
    const enabled = request.enabled;

    const rows = await this.#run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql`UPDATE workers SET capabilities = jsonb_set(capabilities, '{agentToolsEnabled}',
        coalesce(capabilities->'agentToolsEnabled', '{}'::jsonb) || jsonb_build_object(${key}::text, ${enabled}::boolean))
        WHERE id = ${row.id}::uuid AND owner_user_id = ${userId}::uuid AND archived_at IS NULL AND revoked_at IS NULL RETURNING id`;
      }),
    );

    if (!rows.length) throw new ConnectError("worker not found", Code.NotFound);
    await this.#options.changed();

    return create(ui.WorkerOperationResponseSchema);
  }

  async install(request: ui.InstallAgentToolRequest): Promise<ui.InstallAgentToolResponse> {
    const row = await this.#owned(workerId(request.workerId));
    validateTool(request.tool);

    if (request.version && !/^\d+\.\d+\.\d+$/.test(request.version))
      throw new ConnectError("invalid tool version", Code.InvalidArgument);

    if (request.version.length > 64 || (request.installRuntime && request.tool !== AgentTool.BROWSER))
      throw new ConnectError("invalid automation install options", Code.InvalidArgument);
    const connection = this.#connection(row.id);
    const tool = row.report?.tools.find((item) => item.tool === request.tool);

    if (!tool) throw new ConnectError("the worker has not reported automation tools yet", Code.FailedPrecondition);

    if (!tool.installable)
      throw new ConnectError(tool.detail || "this tool cannot be installed here", Code.FailedPrecondition);

    if (tool.install?.state === "running")
      throw new ConnectError("this tool is already being installed", Code.FailedPrecondition);

    const result = await connection.sendCommand(
      {
        case: "installAgentTool",
        value: {
          tool: request.tool,
          version: request.version,
          installId: Bun.randomUUIDv7(),
          installRuntime: request.installRuntime,
        },
      },
      15_000,
    );

    if (!result.ok)
      throw new ConnectError(
        result.errorMessage || result.errorCode || "the install did not start",
        Code.FailedPrecondition,
      );
    this.#logs.delete(`${row.id}/${request.tool}`);

    return create(ui.InstallAgentToolResponseSchema, { started: [row.id] });
  }

  async refresh(request: ui.RefreshAgentToolsRequest): Promise<ui.RefreshAgentToolsResponse> {
    const rows = request.workerId
      ? [await this.#owned(workerId(request.workerId))]
      : [...(await this.#rows()).values()];

    const skipped: string[] = [];

    for (let offset = 0; offset < rows.length; offset += 4) {
      await Promise.all(
        rows.slice(offset, offset + 4).map(async (row) => {
          try {
            const result = await this.#connection(row.id).sendCommand({ case: "probeAgentTools", value: {} }, 30_000);

            if (!result.ok || !result.agentTools)
              return void skipped.push(`${row.id}: ${result.errorMessage || "probe failed"}`);
            await this.report(row.id, result.agentTools);
          } catch (cause) {
            skipped.push(`${row.id}: ${ConnectError.from(cause).rawMessage}`);
          }
        }),
      );
    }

    return create(ui.RefreshAgentToolsResponseSchema, { skipped });
  }

  async run(request: ui.RunAgentToolRequest): Promise<ui.RunAgentToolResponse> {
    const row = await this.#owned(workerId(request.workerId));
    const operation = request.operation;

    if (!operation) throw new ConnectError("choose an automation operation", Code.InvalidArgument);
    validateOperation(operation);
    const connection = this.#connection(row.id);
    const tool = this.#authorize(row, operation.tool);

    if (operation.operation === "screenshot" && !tool.screenshot)
      throw new ConnectError("this tool does not support screenshots", Code.FailedPrecondition);
    const result = await connection.sendCommand({ case: "runAgentTool", value: operation }, 90_000);

    if (!result.ok || !result.agentTool)
      throw new ConnectError(
        result.errorMessage || result.errorCode || "automation operation failed",
        Code.FailedPrecondition,
      );
    const output = result.agentTool;

    if (
      output.operation !== operation.operation ||
      Buffer.byteLength(output.text) > MAX_TEXT ||
      output.data.byteLength > MAX_IMAGE
    )
      throw new ConnectError("automation output is invalid or exceeds the size limit", Code.ResourceExhausted);

    if (output.data.byteLength && (operation.operation !== "screenshot" || output.mimeType !== "image/png"))
      throw new ConnectError("invalid automation image output", Code.FailedPrecondition);

    return create(ui.RunAgentToolResponseSchema, { result: output });
  }
}

export interface CoreAgentToolsMethods {
  installAgentTool(request: ui.InstallAgentToolRequest): Promise<ui.InstallAgentToolResponse>;
  refreshAgentTools(request: ui.RefreshAgentToolsRequest): Promise<ui.RefreshAgentToolsResponse>;
  runAgentTool(request: ui.RunAgentToolRequest): Promise<ui.RunAgentToolResponse>;
  setAgentToolEnabled(request: ui.SetAgentToolEnabledRequest): Promise<ui.WorkerOperationResponse>;
}

export const coreAgentToolsMethods: CoreAgentToolsMethods = {
  installAgentTool(this: GatewayCore, request) {
    return this.agentTools.install(request);
  },
  refreshAgentTools(this: GatewayCore, request) {
    return this.agentTools.refresh(request);
  },
  runAgentTool(this: GatewayCore, request) {
    return this.agentTools.run(request);
  },
  setAgentToolEnabled(this: GatewayCore, request) {
    return this.agentTools.setEnabled(request);
  },
};
