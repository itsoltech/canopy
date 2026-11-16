import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { Effect } from "effect";
import { Journal, type StorageCleanupGrant } from "./journal.ts";

const dir = tempDir("canopy-storage-journal-");
let sequence = 0;
const fresh = () => join(dir, `journal-${++sequence}.db`);

const grant: StorageCleanupGrant = {
  threadId: "11111111-1111-4111-8111-111111111111",
  provider: 1,
  providerProfileId: "native",
  providerThreadIds: ["session-1"],
  homePath: "/worker-data/codex-home",
};

const withJournal = <A, E>(path: string, use: (journal: Journal["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* Journal;

      return yield* use(journal);
    }).pipe(Effect.provide(Journal.layer(path))),
  );

describe("durable storage cleanup grants", () => {
  test("preserves the exact home across restart and leaves a completed tombstone", async () => {
    const path = fresh();
    await withJournal(path, (journal) => journal.grantStorageCleanup(grant));
    await withJournal(path, (journal) =>
      Effect.gen(function* () {
        expect(yield* journal.pendingStorageCleanup()).toEqual([grant]);
        expect(yield* journal.hasStorageCleanup(grant.threadId)).toBe(true);
        yield* journal.completeStorageCleanup(grant.threadId);
      }),
    );
    await withJournal(path, (journal) =>
      Effect.gen(function* () {
        expect(yield* journal.pendingStorageCleanup()).toEqual([]);
        expect(yield* journal.hasStorageCleanup(grant.threadId)).toBe(true);
      }),
    );
  });
});
