import { AcpClient, type McpServer } from "@canopy/acp";
import { PermissionMode, type ThreadSpec } from "@canopy/contracts";
import { automationMcp, automationMcpKey } from "../local-automation.ts";
import type { TurnSettings } from "../turn-input.ts";
import type { ResolvedProfile } from "../profiles.ts";
import type { McpToolsListed } from "../../agent-tools-mcp/index.ts";
import { closeAcpResources } from "./cleanup.ts";
import { acpThreadBus } from "./bus.ts";
import type { AcpProvider, AcpThreadSession, AcpThreadOptions, AcpSettings } from "./thread-types.ts";

export function sessionSettings(spec: ThreadSpec, settings?: TurnSettings) {
  const chosen = {
    model: settings?.model || spec.model,
    effort: settings?.effort || "",
    permissionMode: settings?.permissionMode || spec.permissionMode || PermissionMode.ASK,
  };

  const key = JSON.stringify([
    chosen,
    spec.cwd,
    spec.enableAgentBus,
    spec.depth,
    spec.enableMemory,
    spec.connectorTools,
    spec.hasDelegatingBot,
    automationMcpKey(spec),
  ]);

  return { chosen, key };
}

/** One process and private set of MCP servers for a single Canopy thread. */
export async function openAcpSession(
  provider: AcpProvider,
  options: AcpThreadOptions,
  spec: ThreadSpec,
  profile: ResolvedProfile,
  settings: { chosen: AcpSettings; key: string },
  sessionId: string,
  preparing: (dispose: () => Promise<void>) => void,
): Promise<AcpThreadSession> {
  const { chosen, key } = settings;
  const launch = provider.launch(spec, profile, chosen, Boolean(sessionId));
  let entry: AcpThreadSession | undefined;
  let automation: ReturnType<typeof automationMcp>;
  let bus: ReturnType<typeof acpThreadBus>;
  let client: AcpClient | undefined;
  let disposed: Promise<void> | undefined;
  const mcpTools = new Map<string, Set<string>>();

  const toolsListed: McpToolsListed = (name, tools) => {
    mcpTools.set(name, new Set(tools.map((tool) => tool.name)));
  };

  const dispose = () => {
    clearTimeout(entry?.idleTimer);
    disposed ??= closeAcpResources([
      () => client?.dispose(),
      () => bus?.close(),
      () => automation?.close(),
      launch.cleanup,
    ]);

    return disposed;
  };

  try {
    automation = automationMcp(options, spec, () => entry?.turnId ?? "", toolsListed);
    bus = acpThreadBus(options, spec, () => entry, toolsListed);
    client = new AcpClient({
      ...launch.options,
      onToolCall: (sessionId, tool) => {
        if (!entry?.turnId || entry.session.sessionId !== sessionId) return;
        const use = provider.platformUse?.(tool);

        if (use) entry.toolUses.set(tool.toolCallId, use);
      },
      callbacks: {
        requestPermission: async (request, signal) => {
          const turn = entry?.turn;

          if (
            !entry?.turnId ||
            entry.session.sessionId !== request.sessionId ||
            !turn ||
            turn.signal.aborted ||
            signal.aborted
          )
            return { outcome: { outcome: "cancelled" } };

          return launch.permission(entry, request, AbortSignal.any([signal, turn.signal]));
        },
      },
    });
    void client.exited.then(dispose).catch(() => {});
    preparing(dispose);
    const info = await client.initialize();
    launch.validate?.(info);

    if ((bus || automation) && info.agentCapabilities?.mcpCapabilities?.http !== true)
      throw new Error(`Installed ${provider.name} lacks HTTP MCP support`);

    const servers: McpServer[] = [
      ...(bus ? [bus.server] : []),
      ...(automation?.servers.map((server) => ({
        type: "http" as const,
        name: server.name,
        url: server.url,
        headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
      })) ?? []),
    ];

    const session = sessionId
      ? await client.restoreSession(sessionId, spec.cwd, servers)
      : await client.newSession(spec.cwd, servers);

    await launch.configure(client, session);
    entry = {
      client,
      session,
      dispose,
      mapper: launch.mapper,
      turnId: "",
      turn: undefined,
      mode: chosen.permissionMode,
      settings: key,
      toolUses: new Map(),
      approvals: new Set(),
      mcpTools,
    };

    return entry;
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${provider.name} session setup and cleanup failed`);
    }

    throw error;
  }
}
