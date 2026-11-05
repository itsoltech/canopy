import { expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { shellInputText } from "@canopy/domain";
import { linkedExecutionFixture } from "./support/linked-execution.ts";
import { watchUntil } from "./support/gateway.ts";

test.skipIf(!dockerAvailable)(
  "a composer shell command submitted at A executes at the thread's home B",
  async () => {
    const f = await linkedExecutionFixture();

    try {
      const thread = await f.fixture.thread(Provider.CLAUDE);
      const remote = qualifyId(thread.id, f.node);

      const sent = await f.a.gateway.api.sendMessage({
        threadId: remote,
        text: "!printf linked-home",
        clientRequestId: crypto.randomUUID(),
      });

      const done = await f.fixture.finished(thread.id, sent.turn!.id.split("~")[0]!);
      expect(done.shellResult?.output).toBe("linked-home");
      expect(done.shellResult?.cwd).toBe(thread.cwd);
      expect(done.inputText).toBe(shellInputText(done.shellResult!));
      const updates = await watchUntil(f.a.gateway.api, remote, (u) => u.length > 0);
      const first = updates[0]!;
      expect(first.change.case).toBe("snapshot");

      if (first.change.case === "snapshot") expect(first.change.value.turns[0]?.shellResult).toEqual(done.shellResult);
      expect(await f.a.store.query("SELECT 1 FROM turns WHERE thread_id=$1::uuid", [thread.id])).toEqual([]);
    } finally {
      await f.close();
    }
  },
  60_000,
);
