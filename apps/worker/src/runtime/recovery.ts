import { Journal } from "../journal/index.ts";
import { reconcileTurn, WORKER_RESTARTED } from "../providers/reconcile.ts";
import type { HostContext } from "./host-context.ts";
import { serviceFailedFromOom } from "./service-invocation.ts";
import { recoverShellInputs } from "./shell-input.ts";

/** Settle the previous process's turns and tasks. */
export async function recoverWorker(ctx: HostContext) {
  await recoverShellInputs(ctx);
  const open = await ctx.state.options.runtime.runPromise(Journal.use((j) => j.openTurns()));
  // A worker settles every orphan before accepting another turn, so one lookup covers all its turns.
  const invocations = new Set(open.flatMap((turn) => (turn.serviceInvocation ? [turn.serviceInvocation] : [])));
  const [previous] = invocations;
  const oom = invocations.size === 1 && previous && (await serviceFailedFromOom(previous));
  let fromTranscript = 0;

  for (const turn of open) {
    const cause =
      oom && turn.serviceInvocation === previous
        ? { ...WORKER_RESTARTED, reason: "the worker service stopped because of memory pressure" }
        : WORKER_RESTARTED;

    const { events, record } = await ctx.state.options.runtime.runPromise(reconcileTurn(turn, cause));

    if (record) fromTranscript++;

    for (const event of events) ctx.ops.sendEvent(event);
  }

  // A graceful stop closed its tasks (worker_shutdown); whatever is still open died without a record: a crash.
  return { turns: open.length, tasks: await ctx.ops.closeOrphans(() => true, "worker_lost"), fromTranscript };
}
