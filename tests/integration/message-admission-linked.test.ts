import { expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { nodeRef } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { linkedProjectFixture } from "./support/linked-projects.ts";
import { eventually } from "./support/gateway.ts";
import { idleTransactions, lockedWrite, pauseChecks } from "./support/message-admission.ts";

test.skipIf(!dockerAvailable)(
  "slow linked sends hold no connection on either computer and leave the home thread writable",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "canopy-admission-linked-"));
    let fixture: Awaited<ReturnType<typeof linkedProjectFixture>> | undefined;
    let paused: ReturnType<typeof pauseChecks> | undefined;

    try {
      fixture = await linkedProjectFixture(directory);
      const { a, b, lb } = fixture;
      const node = nodeRef(lb.hello().nodeId);

      const thread = (
        await b.gw.api.createThread({ projectId: b.project.id, workspaceId: b.workspace.id, provider: Provider.CODEX })
      ).thread!;

      const threadId = `${thread.id}~${node}`;
      // This fixture's worker reports no attachments root; the files only serve as the pause point.
      await b.gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE workers SET capabilities=coalesce(capabilities,'{}'::jsonb)
            || '{"attachmentsRoot":"/worker-data/attachments"}'::jsonb WHERE id=${b.workerId}::uuid`;
        }),
      );

      // Files already on the home computer: the sender forwards them as they are.
      const files = await Promise.all(
        Array.from({ length: 4 }, async (_, i) => {
          const data = new TextEncoder().encode(`notes ${i}`);

          return `${(await b.gw.api.uploadAttachment({ name: `notes-${i}.txt`, data })).attachment!.id}~${node}`;
        }),
      );

      const checks = pauseChecks(b.gw.core);
      paused = checks;

      const sends = files.map((file, i) =>
        a.gw.api.sendMessage({
          threadId,
          text: `Slow linked send ${i}`,
          attachmentIds: [file],
          clientRequestId: crypto.randomUUID(),
        }),
      );

      await eventually(
        async () => checks.waiting(),
        (n) => n === files.length,
      );
      expect(await idleTransactions(a.gw.runtime)).toBe(0);
      expect(await idleTransactions(b.gw.runtime)).toBe(0);
      await lockedWrite(b.gw.runtime, thread.id);
      const renamed = await a.gw.api.updateThread({ threadId, title: "Renamed meanwhile" }, { timeoutMs: 2000 });
      expect(renamed.thread?.title).toBe("Renamed meanwhile");

      checks.release();
      const sent = await Promise.all(sends);
      expect(new Set(sent.map((r) => r.turn?.id)).size).toBe(files.length);

      const ordinals = await b.gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql<{ ordinal: number }>`SELECT ordinal FROM turns WHERE thread_id=${thread.id}::uuid
            ORDER BY ordinal`;
        }),
      );

      expect(ordinals.map((t) => t.ordinal)).toEqual([1, 2, 3, 4]);
    } finally {
      paused?.release();
      await fixture?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
