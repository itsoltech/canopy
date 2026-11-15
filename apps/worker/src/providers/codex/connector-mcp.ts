import type { ThreadSpec } from "@canopy/contracts";
import { Effect } from "effect";
import { platformMcp, type PlatformMcp } from "../mcp-bus.ts";
import type { CodexThreadContext } from "./thread-types.ts";
import { CodexThreadError, fail, type Entry } from "./thread-types.ts";
import { connectorSessionCatalog } from "@canopy/domain/connector-session";
import type { threadSessions } from "./thread-sessions.ts";
import { automationMcp } from "../local-automation.ts";

/** A private transport per thread; external credentials and authorization remain in the gateway. */
export function codexConnectorMcp(ctx: CodexThreadContext) {
  const bridges = new Map<string, PlatformMcp>();
  const automation = new Map<string, { key: string; bridge: ReturnType<typeof automationMcp> }>();
  const closing = new Set<Promise<void>>();

  const retire = (bridge: ReturnType<typeof automationMcp>) => {
    if (!bridge) return;
    const pending = bridge.close().finally(() => closing.delete(pending));
    closing.add(pending);
    // Session teardown awaits these promises; handle rejections immediately during catalog replacement.
    void pending.catch(() => {});
  };

  const config = (spec: ThreadSpec) => {
    ctx.connectorCatalog.set(spec.threadId, spec.connectorTools);
    let bridge = bridges.get(spec.threadId);

    if (!bridge) {
      bridge = platformMcp({
        threadId: spec.threadId,
        depth: spec.depth,
        agentBus: false,
        get connectorTools() {
          return ctx.connectorCatalog.get(spec.threadId) ?? [];
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
    const key = JSON.stringify(spec.localMcpTools);
    let local = automation.get(spec.threadId);

    if (!local || local.key !== key) {
      retire(local?.bridge);
      local = {
        key,
        bridge: automationMcp(ctx.options, spec, () => {
          const entry = ctx.byPlatform.get(spec.threadId);

          return [...(entry?.codexToPlatform ?? [])].findLast(([id]) => !entry?.finishedTurns.has(id))?.[1] ?? "";
        }),
      };
      automation.set(spec.threadId, local);
    }

    ctx.automationCatalog.set(spec.threadId, key);

    return {
      mcp_servers: {
        canopy_connectors: {
          url: server.url,
          http_headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
          // Only gateway-verified connector calls use this server. Gateway enforces grants and approvals.
          default_tools_approval_mode: "approve",
          required: true,
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
    close: async () => {
      for (const bridge of bridges.values()) bridge.close();
      await Promise.all([...closing, ...[...automation.values()].map((local) => local.bridge?.close())]);
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
  previous: ThreadSpec["connectorTools"] | undefined,
  previousAutomation?: string,
) =>
  Effect.gen(function* () {
    if (
      (previous !== undefined &&
        JSON.stringify(connectorSessionCatalog(previous ?? [])) !==
          JSON.stringify(connectorSessionCatalog(spec.connectorTools))) ||
      (previousAutomation !== undefined && previousAutomation !== JSON.stringify(spec.localMcpTools))
    )
      entry = yield* reconfigure(spec, entry);

    const inventory = yield* ctx.codex
      .request("mcpServerStatus/list", { threadId: entry.codexId, serverName: "canopy_connectors" })
      .pipe(Effect.mapError(fail(spec.threadId, "connectors")));

    const server = inventory.data.find((s) => s.name === "canopy_connectors");

    if (
      server?.runtimeStatus !== "connected" ||
      server.toolsError ||
      JSON.stringify(Object.keys(server.tools).sort()) !== JSON.stringify(spec.connectorTools.map((t) => t.name).sort())
    )
      return yield* new CodexThreadError({
        threadId: spec.threadId,
        operation: "connectors",
        message: "Codex could not load connector tools",
      });

    return entry;
  }).pipe(Effect.tapError(() => Effect.sync(() => ctx.connectorCatalog.set(spec.threadId, previous ?? []))));
