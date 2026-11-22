import type { Command, CommandResult } from "@canopy/contracts";
import { coreLog } from "../core/core-broadcast.ts";
import { coreState } from "../core/core-context.ts";
import type { GatewayCore } from "../core/core.ts";
import type { WorkerConnection } from "../worker-link/index.ts";
import { reserveHabitContext } from "./habit-context.ts";

export type OutboundKind = Exclude<Command["kind"], { case: undefined }>;

type Handoff = { ack: Promise<CommandResult | undefined> } | undefined;

const handoffs = new WeakMap<WorkerConnection, Map<string, Promise<Handoff>>>();

export async function sendWithHabitContext(
  core: GatewayCore,
  connection: WorkerConnection,
  commandId: string,
  kind: OutboundKind,
  send: (outbound: OutboundKind) => Handoff | Promise<Handoff>,
): Promise<Handoff> {
  if (kind.case !== "startTurn" || !connection.isOpen || !connection.hello.capabilities.includes("memory_habits_v1"))
    return send(kind);

  const onLink = handoffs.get(connection) ?? new Map<string, Promise<Handoff>>();
  const inProgress = onLink.get(commandId);

  if (inProgress) return inProgress;

  const handoff = habitEnvelope(core, connection.workerId, kind)
    .then(send)
    .finally(() => onLink.delete(commandId));

  // Concurrent outbox flushes must share the send while the habit reservation commits.
  onLink.set(commandId, handoff);
  handoffs.set(connection, onLink);

  return handoff;
}

async function habitEnvelope(core: GatewayCore, workerId: string, kind: Extract<OutboundKind, { case: "startTurn" }>) {
  const { actions, options } = core[coreState];

  const habitContext = await actions.run(reserveHabitContext(options.userId, workerId, kind.value)).catch(() => {
    coreLog(core, "Could not load approved habits for StartTurn");

    return "";
  });

  return habitContext ? { case: kind.case, value: { ...kind.value, habitContext } } : kind;
}
