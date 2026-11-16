import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentToolResultSchema, ThreadEventSchema, type ThreadEvent } from "@canopy/contracts";
import { MarkdownImageImports } from "./markdown-imports.ts";

test("closing one thread aborts imports and flushes its held journal boundary while another import continues", async () => {
  const imports = new MarkdownImageImports();
  const releases = new Map<string, () => void>();
  const signals = new Map<string, AbortSignal>();
  const sent: ThreadEvent[] = [];

  const running = ["archived", "survivor"].map((threadId) => {
    const started = create(ThreadEventSchema, { threadId, turnId: "turn", body: { case: "turnStarted", value: {} } });
    imports.observe(started);
    const entered = Promise.withResolvers<void>();
    imports.enqueue(started, "item", async (_request, signal) => {
      signals.set(threadId, signal);
      const release = Promise.withResolvers<void>();
      releases.set(threadId, release.resolve);
      entered.resolve();
      await release.promise;

      return create(AgentToolResultSchema);
    });
    imports.hold(
      create(ThreadEventSchema, {
        threadId,
        turnId: "turn",
        journalSeq: 10n,
        body: { case: "turnFinished", value: {} },
      }),
      (event) => sent.push(event),
      () => true,
    );

    return entered.promise;
  });

  try {
    await Promise.all(running);
    imports.closeThread("archived");
    expect(signals.get("archived")?.aborted).toBe(true);
    expect(signals.get("survivor")?.aborted).toBe(false);
    expect(sent.map((event) => event.threadId)).toEqual(["archived"]);
    expect(imports.canSend(create(ThreadEventSchema, { threadId: "archived", journalSeq: 11n }))).toBe(true);
    expect(imports.canSend(create(ThreadEventSchema, { threadId: "survivor", journalSeq: 11n }))).toBe(false);
    releases.get("archived")?.();
    await Bun.sleep(0);
    expect(sent).toHaveLength(1);
    releases.get("survivor")?.();
    await Bun.sleep(0);
    expect(sent.map((event) => event.threadId)).toEqual(["archived", "survivor"]);
  } finally {
    for (const release of releases.values()) release();
    imports.close();
  }
});
