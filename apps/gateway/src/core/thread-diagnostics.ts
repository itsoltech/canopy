import type { GatewayCore } from "./core.ts";
import { coreState } from "./core-context.ts";
import { coreLog } from "./core-broadcast.ts";

/** Allowlisted metadata only: never pass input, output, paths or provider error messages. */
export function threadDiagnostic(
  core: GatewayCore,
  event: "message_decision" | "steer_delivery" | "turn_started" | "turn_finished",
  fields: {
    threadId: string;
    turnId: string;
    steerId?: string;
    delivery?: "new_turn" | "steer" | "queue";
    outcome?: "accepted" | "consumed" | "requeued" | "failed" | "released";
    reason?:
      | "running_turn"
      | "no_running_turn"
      | "thread_not_ready"
      | "queue_requested"
      | "not_consumed"
      | "shell_failed";
    source?: string;
    status?: string;
    queuedTurnId?: string;
  },
): void {
  const write = () => coreLog(core, JSON.stringify({ event, ...fields }));

  // Admission diagnostics describe committed decisions, including when the caller retries.
  if (!core[coreState].actions.defer(write)) write();
}
