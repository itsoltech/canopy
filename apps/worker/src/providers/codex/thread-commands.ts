import { threadLifecycle } from "../thread-lifecycle.ts";
import { CodexThreadError, type CodexThreadContext } from "./thread-types.ts";
import type { threadSessions } from "./thread-sessions.ts";
import type { threadTurnSettings } from "./thread-catalog.ts";
import type { CodexThreads } from "./threads.ts";
import { threadTurns, threadGoals } from "./thread-turns.ts";
import { unloadCodexThread } from "./thread-unload.ts";

export function codexThreadCommands(
  ctx: CodexThreadContext,
  sessions: ReturnType<typeof threadSessions>,
  turnSettings: ReturnType<typeof threadTurnSettings>,
): Pick<
  CodexThreads["Service"],
  "create" | "rewind" | "startTurn" | "interrupt" | "steer" | "setGoal" | "stopTask" | "unload"
> {
  const lifecycle = threadLifecycle(
    (threadId) => new CodexThreadError({ threadId, operation: "unload", message: "The thread is being unloaded" }),
  );

  const turns = threadTurns(ctx, sessions.ensureLoaded, turnSettings, sessions.reconfigure);
  const goals = threadGoals(ctx, sessions.ensureLoaded);

  return {
    create: (spec, fork) => lifecycle.run(spec.threadId, () => sessions.create(spec, fork)),
    rewind: (request) => lifecycle.run(request.thread?.threadId ?? "", () => sessions.rewind(request)),
    ...turns,
    startTurn: (spec, turnId, input, settings) =>
      lifecycle.run(spec.threadId, (current) =>
        turns.startTurn(spec, turnId, input, {
          model: settings?.model ?? "",
          effort: settings?.effort ?? "",
          ...settings,
          canSubmit: () => current() && settings?.canSubmit?.() !== false,
        }),
      ),
    unload: (threadId) => lifecycle.unload(threadId, unloadCodexThread(ctx, threadId)),
    ...goals,
    setGoal: (spec, directive, objective, tokenBudget) =>
      lifecycle.run(spec.threadId, () => goals.setGoal(spec, directive, objective, tokenBudget)),
  };
}
