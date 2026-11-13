import type { ThreadSpec } from "@canopy/contracts";
import { Effect } from "effect";
import { platformMcp, type PlatformMcp } from "../mcp-bus.ts";
import type { CodexThreadContext } from "./thread-types.ts";
import { CodexThreadError, fail, type Entry } from "./thread-types.ts";
import { connectorSessionCatalog } from "@canopy/domain/connector-session";
import type { threadSessions } from "./thread-sessions.ts";

/** A private transport per thread; external credentials and authorization remain in the gateway. */
export function codexConnectorMcp(ctx: CodexThreadContext) {
  const bridges = new Map<string, PlatformMcp>();

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

    return {
      mcp_servers: {
        canopy_connectors: {
          url: server.url,
          http_headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
          // Only gateway-verified connector calls use this server. Gateway enforces grants and approvals.
          default_tools_approval_mode: "approve",
          required: true,
        },
      },
    };
  };

  return {
    config,
    close: () => {
      for (const bridge of bridges.values()) bridge.close();
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
) =>
  Effect.gen(function* () {
    if (
      previous !== undefined &&
      JSON.stringify(connectorSessionCatalog(previous ?? [])) !==
        JSON.stringify(connectorSessionCatalog(spec.connectorTools))
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
