import type { ThreadSpec } from "@canopy/contracts";
import { threadMemoryTools } from "../memory-tools.ts";
import { Effect } from "effect";
import { platformMcp, type PlatformMcp } from "../mcp-bus.ts";
import type { CodexThreadContext } from "./thread-types.ts";
import { CodexThreadError, fail, type Entry } from "./thread-types.ts";
import { connectorSessionCatalog } from "@canopy/domain/connector-session";
import type { threadSessions } from "./thread-sessions.ts";
import { automationMcp, automationMcpKey } from "../local-automation.ts";

// Codex inherits dynamic tools in forks. Conditional tools use the current platform thread’s MCP catalog.
const sessionTools = (spec?: ThreadSpec) =>
  spec?.enableAgentBus
    ? [
        "list_agents" as const,
        ...(spec.depth === 0 ? (["start_thread"] as const) : []),
        ...(spec.hasDelegatingBot ? (["message_delegating_bot"] as const) : []),
        ...(spec.enableWorktreeSwitch ? (["switch_worktree"] as const) : []),
      ]
    : [];

const catalogKey = (spec: ThreadSpec) =>
  JSON.stringify([
    connectorSessionCatalog(spec.connectorTools),
    sessionTools(spec),
    spec.enableMemory,
    automationMcpKey(spec),
  ]);

/** A private transport per thread; external credentials and authorization remain in the gateway. */
export function codexConnectorMcp(ctx: CodexThreadContext) {
  const bridges = new Map<string, PlatformMcp>();
  const automation = new Map<string, { key: string; bridge: ReturnType<typeof automationMcp> }>();
  const closing = new Map<string, Set<Promise<void>>>();

  const retire = (threadId: string, bridge: ReturnType<typeof automationMcp>) => {
    if (!bridge) return;
    let retired = closing.get(threadId);

    if (!retired) {
      retired = new Set();
      closing.set(threadId, retired);
    }

    const pending = bridge.close().finally(() => retired.delete(pending));
    retired.add(pending);
    // Session teardown awaits these promises; handle rejections immediately during catalog replacement.
    void pending.catch(() => {});
  };

  const config = (spec: ThreadSpec) => {
    ctx.mcpSpecs.set(spec.threadId, spec);
    let bridge = bridges.get(spec.threadId);

    if (!bridge) {
      bridge = platformMcp({
        threadId: spec.threadId,
        depth: spec.depth,
        get enableMemory() {
          return ctx.mcpSpecs.get(spec.threadId)?.enableMemory ?? false;
        },
        get agentBus() {
          return sessionTools(ctx.mcpSpecs.get(spec.threadId));
        },
        get connectorTools() {
          return ctx.mcpSpecs.get(spec.threadId)?.connectorTools ?? [];
        },
        turnId: () => {
          const entry = ctx.byPlatform.get(spec.threadId);
          const turn = [...(entry?.codexToPlatform ?? [])].findLast(([id]) => !entry?.finishedTurns.has(id));

          return turn?.[1] ?? "";
        },
        callTool: ctx.options.callTool,
        record: (init) =>
          Effect.runPromise(ctx.journal.append(spec.threadId, init)).then((event) => {
            ctx.options.publish(event);

            return event;
          }),
      });
      bridges.set(spec.threadId, bridge);
    }

    const server = bridge.server;
    const key = automationMcpKey(spec);
    let local = automation.get(spec.threadId);

    if (!local || local.key !== key) {
      retire(spec.threadId, local?.bridge);
      local = {
        key,
        bridge: automationMcp(ctx.options, spec, () => {
          const entry = ctx.byPlatform.get(spec.threadId);

          return [...(entry?.codexToPlatform ?? [])].findLast(([id]) => !entry?.finishedTurns.has(id))?.[1] ?? "";
        }),
      };
      automation.set(spec.threadId, local);
    }

    return {
      mcp_servers: {
        canopy_connectors: {
          url: server.url,
          http_headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
          // The gateway authorizes connector and delegation calls.
          default_tools_approval_mode: "approve",
          required: true,
          ...((spec.enableWorktreeSwitch || (spec.enableAgentBus && spec.depth === 0)) && { tool_timeout_sec: 360 }),
        },
        ...Object.fromEntries(
          (local.bridge?.servers ?? []).map((server) => [
            server.name,
            { url: server.url, http_headers: server.headers, default_tools_approval_mode: "approve", required: true },
          ]),
        ),
      },
    };
  };

  return {
    config,
    unload: async (threadId: string) => {
      const bridge = bridges.get(threadId);
      const local = automation.get(threadId);
      bridges.delete(threadId);
      automation.delete(threadId);
      bridge?.close();
      await Promise.all([...(closing.get(threadId) ?? []), local?.bridge?.close()]);
      closing.delete(threadId);
    },
    close: async () => {
      for (const bridge of bridges.values()) bridge.close();
      await Promise.all([
        ...[...closing.values()].flatMap((retired) => [...retired]),
        ...[...automation.values()].map((local) => local.bridge?.close()),
      ]);
      automation.clear();
      bridges.clear();
    },
  };
}

/** A native catalog check waits for connection startup and rejects partial/failed attachment. */
export const refreshCodexConnectors = (
  ctx: CodexThreadContext,
  reconfigure: ReturnType<typeof threadSessions>["reconfigure"],
  spec: ThreadSpec,
  entry: Entry,
  previous: ThreadSpec | undefined,
) =>
  Effect.gen(function* () {
    if (previous && catalogKey(previous) !== catalogKey(spec)) entry = yield* reconfigure(spec, entry);

    const inventory = yield* ctx.codex
      .request("mcpServerStatus/list", { threadId: entry.codexId, serverName: "canopy_connectors" })
      .pipe(Effect.mapError(fail(spec.threadId, "connectors")));

    const server = inventory.data.find((s) => s.name === "canopy_connectors");

    const expected = [
      ...spec.connectorTools.map((t) => t.name),
      ...sessionTools(spec),
      ...threadMemoryTools(spec.enableMemory).map((t) => t.name),
    ].sort();

    if (
      server?.runtimeStatus !== "connected" ||
      server.toolsError ||
      JSON.stringify(Object.keys(server.tools).sort()) !== JSON.stringify(expected)
    )
      return yield* new CodexThreadError({
        threadId: spec.threadId,
        operation: "connectors",
        message: "Codex could not load connector tools",
      });

    return entry;
  }).pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        if (previous) ctx.mcpSpecs.set(spec.threadId, previous);
      }),
    ),
  );
