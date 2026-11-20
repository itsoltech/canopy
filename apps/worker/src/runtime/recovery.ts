import { Journal } from "../journal/index.ts";
import { reconcileTurn, WORKER_RESTARTED } from "../providers/reconcile.ts";
import type { HostContext } from "./host-context.ts";
import { recoverShellInputs } from "./shell-input.ts";

/** Settle the previous process's turns and tasks. */
export async function recoverWorker(ctx: HostContext) {
  await recoverShellInputs(ctx);
  const open = await ctx.state.options.runtime.runPromise(Journal.use((j) => j.openTurns()));
  let fromTranscript = 0;

  for (const turn of open) {
    const { events, record } = await ctx.state.options.runtime.runPromise(reconcileTurn(turn, WORKER_RESTARTED));

    if (record) fromTranscript++;

    for (const event of events) ctx.ops.sendEvent(event);
  }

  // A graceful stop closed its tasks (worker_shutdown); whatever is still open died without a record: a crash.
  return { turns: open.length, tasks: await ctx.ops.closeOrphans(() => true, "worker_lost"), fromTranscript };
}
