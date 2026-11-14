import { Provider, TurnOutcome, type TurnFinished } from "@canopy/contracts";
import { classifyFailure } from "@canopy/domain";
import { providerOf } from "../store/instance-config.ts";
import { coreLog, coreRun } from "./core-broadcast.ts";
import type { GatewayCore } from "./core.ts";

/**
 * How a finished turn speaks for its instance's login on that worker (docs/worker-config.md, account status): a
 * rejected login marks the account as needing sign-in, a completed turn clears the mark.
 */
export function coreTurnLogin(core: GatewayCore, workerId: string, threadId: string, end: TurnFinished): Promise<void> {
  const rejected =
    end.outcome === TurnOutcome.FAILED &&
    classifyFailure(end.reason, end.errorClass || end.errorCode) === "auth_required";

  if (!rejected && end.outcome !== TurnOutcome.COMPLETED) return Promise.resolve();

  // Queued synchronously, in the order the worker's events arrive: a rejection that is still reading the account
  // runs before a later success, so the success clears it instead of being overwritten by it.
  return core.accounts.afterTurn(workerId, async () => {
    if (!rejected && !core.accounts.hasRejected(workerId)) return;

    try {
      const thread = await coreRun(core, (s) => s.thread(threadId, true, true));
      const provider = providerOf(thread.provider);

      if (thread.worker_id !== workerId || provider === Provider.UNSPECIFIED) return;
      const id = thread.provider_profile_id || "native";

      if (rejected) await core.accounts.rejected(workerId, provider, id);
      else await core.accounts.succeeded(workerId, provider, id);
    } catch (cause) {
      coreLog(core, `account status after turn not updated: ${cause instanceof Error ? cause.name : "error"}`);
    }
  });
}
