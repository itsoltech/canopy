import type { ui } from "@canopy/contracts";
import { watchUntil } from "./gateway.ts";
import type { InstanceFixture } from "./instance-fixture.ts";

const turnsOf = (update: ui.ThreadUpdate): ui.Turn[] => {
  if (update.change.case === "turn") return [update.change.value];

  if (update.change.case === "snapshot") return update.change.value.turns;

  return [];
};

/** Start the watch budget after CLI admission; release fixture output only after its snapshot arrives. */
export function providerUsageGate() {
  const pending = new Map<
    string,
    { arrived: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> }
  >();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const gate = pending.get(await request.text());

      if (!gate) return new Response("unexpected fixture input", { status: 400 });
      gate.arrived.resolve();
      await gate.release.promise;

      return new Response("ready");
    },
  });

  return {
    url: server.url.href,
    async turn(f: InstanceFixture, threadId: string, text: string): Promise<ui.Turn | undefined> {
      const gate = { arrived: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
      pending.set(text, gate);

      try {
        const turn = await f.send(threadId, text);
        await gate.arrived.promise;

        const updates = await watchUntil(
          f.gw.api,
          threadId,
          (values) =>
            values
              .flatMap(turnsOf)
              .some((t) => t.id === turn.id && ["completed", "failed", "interrupted"].includes(t.status)),
          (update) => {
            if (update.change.case === "snapshot") gate.release.resolve();
          },
        );

        return updates.flatMap(turnsOf).findLast((t) => t.id === turn.id);
      } finally {
        gate.release.resolve();
        pending.delete(text);
      }
    },
    async close() {
      for (const gate of pending.values()) {
        gate.arrived.resolve();
        gate.release.resolve();
      }

      await server.stop(true);
    },
  };
}
