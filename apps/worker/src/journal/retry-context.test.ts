import { expect, test } from "bun:test";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { Effect } from "effect";
import { Journal } from "./index.ts";

const temp = tempDirs();

test("retry context survives ACKs, a worker restart and repeated retries without crossing threads", async () => {
  const path = join(temp("canopy-retry-context-"), "journal.db");
  const request = "Finish the migration without repeating completed side effects";

  const run = <A, E>(work: Effect.Effect<A, E, Journal>) =>
    Effect.runPromise(work.pipe(Effect.provide(Journal.layer(path)), Effect.scoped));

  await run(
    Journal.use((journal) =>
      Effect.gen(function* () {
        yield* journal.rememberRequest("thread-a", request);
        yield* journal.rememberRequest("thread-b", "Another request");
        yield* journal.ack("thread-a", 100n);
      }),
    ),
  );

  await run(
    Journal.use((journal) =>
      Effect.gen(function* () {
        yield* journal.rememberRequest("thread-a", "Continue");
        yield* journal.rememberRequest("thread-a", "Continue");
        expect(yield* journal.recoveryInstructions("thread-a")).toContain(JSON.stringify(request));
        expect(yield* journal.recoveryInstructions("thread-a")).not.toContain("Another request");
        expect(yield* journal.recoveryInstructions("unknown-thread")).toBe("");
        yield* journal.rememberRequest("thread-a", "A new task");
        expect(yield* journal.recoveryInstructions("thread-a")).not.toContain(request);
      }),
    ),
  );
});
