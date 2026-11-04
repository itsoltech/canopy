import { existsSync } from "node:fs";
import { Effect } from "effect";
import type { ThreadEventInit } from "../../journal/index.ts";
import { transcriptPath } from "./transcript.ts";

import type { ClaudeThreadContext, Session } from "./thread-types.ts";
import { readFrom, goalVerdictOf } from "./session-io.ts";

export function sessionOutput(ctx: ClaudeThreadContext) {
  const { options, journal } = ctx;

  const record = async (threadId: string, init: ThreadEventInit) => {
    const enriched = options.enrich ? await options.enrich(init) : init;

    return Effect.runPromise(
      journal.append(threadId, enriched).pipe(Effect.tap((event) => Effect.sync(() => options.publish(event)))),
    );
  };

  const serial = (session: Session, run: () => Promise<void>) => {
    const next = session.io.then(run, run).catch(() => {});
    session.io = next;

    return next;
  };

  const readOutput = (session: Session, taskId: string, file?: string) =>
    serial(session, async () => {
      const path = file ?? session.mapper.outputFile(taskId);

      if (!path || !existsSync(path)) return;
      const state = session.outputs.get(taskId) ?? { offset: 0, decoder: new TextDecoder() };
      session.outputs.set(taskId, state);
      const chunk = readFrom(path, state.offset);

      if (chunk.length === 0) return;
      state.offset += chunk.length;

      for (const init of session.mapper.taskOutput(taskId, state.decoder.decode(chunk, { stream: true })))
        await record(session.threadId, init);
    });

  /** Goal verdicts the evaluator wrote to the session transcript since the last read. */
  const readGoalVerdicts = (session: Session) =>
    serial(session, async () => {
      const transcript = session.transcript;
      transcript.path ??= transcriptPath(session.home, session.sessionId);

      if (!transcript.path) return;
      const chunk = readFrom(transcript.path, transcript.offset);
      transcript.offset += chunk.length;
      const lines = (transcript.tail + new TextDecoder().decode(chunk)).split("\n");
      transcript.tail = lines.pop() ?? "";

      for (const line of lines) {
        const verdict = goalVerdictOf(line);

        if (verdict) for (const init of session.mapper.goalVerdict(verdict)) await record(session.threadId, init);
      }
    });

  return { record, readOutput, readGoalVerdicts };
}
