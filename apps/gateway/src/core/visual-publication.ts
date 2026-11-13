import { createHash } from "node:crypto";
import { create, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import type { AgentBusArgs } from "@canopy/domain";
import { THREAD_VISUALS_CAPABILITY } from "@canopy/domain/release/protocol";
import { decodeVisualSpec, VISUAL_LIMITS } from "@canopy/domain/visuals";
import { Effect, Result } from "effect";
import { SqlClient } from "effect/sql";
import { Invalid, type CallSource, type ThreadRow } from "../store/index.ts";
import { publishVisual, readVisual, visualManifest } from "../store/visuals.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** render_visual (docs/agent-visuals.md §5): validate again, store a version atomically and announce the manifest. */
export async function publishThreadVisual(
  core: GatewayCore,
  source: CallSource,
  caller: ThreadRow,
  args: AgentBusArgs["render_visual"],
): Promise<JsonValue> {
  const workerId = caller.worker_id;
  const connection = workerId ? core.link.connections.get(workerId) : undefined;

  if (!workerId || !connection?.isOpen) throw new Invalid("This computer is offline. Reconnect it to show visuals.");

  if (!connection.hello.capabilities.includes(THREAD_VISUALS_CAPABILITY))
    throw new Invalid("Update this computer to show visuals in Canopy.");

  if (!UUID.test(source.turnId)) throw new Invalid("Visuals require a running turn.");
  const decoded = decodeVisualSpec(args.spec);

  if (Result.isFailure(decoded)) throw new Invalid(`spec: ${decoded.failure}`);
  const spec = decoded.success.json;

  const committed = await core[coreState].actions.run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      publishVisual(sql, {
        source,
        ownerId: caller.owner_user_id,
        workerId,
        title: args.title,
        description: args.description,
        height: args.height ?? VISUAL_LIMITS.defaultHeight,
        spec,
        sha256: createHash("sha256").update(spec).digest("hex"),
        ...(args.visual_id !== undefined &&
          args.expected_version !== undefined && {
            update: { visualId: args.visual_id, expectedVersion: args.expected_version },
          }),
      }),
    ),
  );

  core.hub.publishThread(
    caller.id,
    create(ui.ThreadUpdateSchema, { change: { case: "event", value: { seq: committed.seq, event: committed.event } } }),
  );

  return committed.result;
}

/** GetVisual: owner-scoped read of one version's spec and the list of versions. */
export async function getThreadVisual(core: GatewayCore, request: ui.GetVisualRequest): Promise<ui.GetVisualResponse> {
  if (!UUID.test(request.threadId) || !UUID.test(request.visualId)) throw new Invalid("invalid visual reference");
  const ownerId = core[coreState].options.userId;

  const { row, versions } = await core[coreState].actions.run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      readVisual(sql, ownerId, request.threadId, request.visualId, request.version),
    ),
  );

  return create(ui.GetVisualResponseSchema, {
    visual: visualManifest(row),
    specJson: row.spec,
    versions,
    createdAt: timestampFromDate(new Date(row.created_at)),
  });
}
