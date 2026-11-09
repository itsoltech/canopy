import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ItemDeltaField, ItemStatus, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { linkedMessage } from "../../apps/gateway/src/computers/remote.ts";
import { eventually } from "./support/gateway.ts";
import { remoteThread, scenarioComputer, scenarioMirror, scenarioWatch } from "./support/sync-scenario.ts";

describe.skipIf(!dockerAvailable)("linked sync isolation and negotiation", () => {
  for (const [oldSubscriber, oldHome] of [
    [false, false],
    [true, false],
    [false, true],
  ] as const) {
    test(`stream text with subscriber legacy=${oldSubscriber}, home legacy=${oldHome}`, async () => {
      const a = await scenarioComputer(oldSubscriber);
      const b = await scenarioComputer(oldHome);
      const abort = new AbortController();

      try {
        const invitation = await a.links.createPairing();
        await b.links.pair(a.links.addresses[0]!, invitation.code);
        const node = b.links.hello().nodeId;
        const id = b.threads[0]!;
        await scenarioMirror(a, node, id, "Scenario 0");
        let batches = 0;
        const remote = a.links.remote.bind(a.links);
        a.links.remote = async function* (...args) {
          for await (const message of remote(...args)) {
            if (args[0] === node && args[1].name === "WatchThread") {
              const update = linkedMessage(ui.ThreadUpdateSchema, message);

              if (update.change.case === "event" && update.change.value.firstSeq) batches++;
            }

            yield message;
          }
        };

        const view = scenarioWatch(remoteThread(a.gateway, node, id, abort.signal));
        await view.until("Scenario 0");
        const { turn, worker } = await begin(b.gateway, id);

        for (let i = 0; i < 80; i++)
          worker.emit(id, turn, {
            case: "itemDelta",
            value: { itemId: "stream", field: ItemDeltaField.TEXT, chunk: "token " },
          });
        expect(
          await eventually(
            async () => text(view.state),
            (value) => value === "token ".repeat(80),
          ),
        ).toBe("token ".repeat(80));
        expect(batches > 0).toBe(!oldSubscriber && !oldHome);
        expect(view.failure).toBeUndefined();
        abort.abort();
        await view.done;
      } finally {
        abort.abort();
        await b.close();
        await a.close();
      }
    }, 60_000);
  }

  test("a paused linked subscriber overflows alone and resumes from its durable checkpoint", async () => {
    const a = await scenarioComputer();
    const b = await scenarioComputer();
    const abort = new AbortController();

    try {
      const invitation = await a.links.createPairing();
      await b.links.pair(a.links.addresses[0]!, invitation.code);
      const node = b.links.hello().nodeId;
      const id = b.threads[0]!;
      await scenarioMirror(a, node, id, "Scenario 0");

      const slow = a.links
        .remote(
          node,
          ui.GatewayService.method.watchThread,
          create(ui.WatchThreadRequestSchema, { threadId: id, incremental: true }),
          abort.signal,
        )
        [Symbol.asyncIterator]();

      const seed = linkedMessage(ui.ThreadUpdateSchema, (await slow.next()).value!);

      if (seed.change.case !== "snapshot") throw new Error("Expected initial full snapshot");
      const checkpoint = seed.change.value.cursor;
      const healthy = scenarioWatch(remoteThread(a.gateway, node, id, abort.signal));
      await healthy.until("Scenario 0");
      const { turn, worker } = await begin(b.gateway, id);

      for (let i = 0; i < 600; i++)
        worker.emit(id, turn, {
          case: "itemDelta",
          value: { itemId: "stream", field: ItemDeltaField.TEXT, chunk: "token " },
        });
      expect(
        await eventually(
          async () => text(healthy.state),
          (value) => value === "token ".repeat(600),
          15_000,
        ),
      ).toBe("token ".repeat(600));
      expect(healthy.failure).toBeUndefined();
      expect(a.links.reachable()).toContain(node);
      const error = await slow.next().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ConnectError);
      expect(error).toMatchObject({ code: Code.DataLoss });

      const resumed = a.links
        .remote(
          node,
          ui.GatewayService.method.watchThread,
          create(ui.WatchThreadRequestSchema, { threadId: id, incremental: true, cursor: checkpoint }),
          abort.signal,
        )
        [Symbol.asyncIterator]();

      const update = linkedMessage(ui.ThreadUpdateSchema, (await resumed.next()).value!);
      expect(update.change.case).toBe("delta");

      if (update.change.case === "delta") expect(text(update.change.value.snapshot)).toBe("token ".repeat(600));
      abort.abort();
      await resumed.return?.(undefined);
      await healthy.done;
    } finally {
      abort.abort();
      await b.close();
      await a.close();
    }
  }, 60_000);
});

async function begin(gateway: Awaited<ReturnType<typeof scenarioComputer>>["gateway"], id: string) {
  gateway.worker.holdTurns = true;

  const turn = (await gateway.api.sendMessage({ threadId: id, text: "Stream", clientRequestId: crypto.randomUUID() }))
    .turn!.id;

  await eventually(async () => gateway.worker.started.has(turn), Boolean);
  gateway.worker.emit(id, turn, {
    case: "itemStarted",
    value: {
      item: {
        itemId: "stream",
        status: ItemStatus.IN_PROGRESS,
        content: { case: "agentMessage", value: { text: "" } },
      },
    },
  });

  return { turn, worker: gateway.worker };
}

function text(snapshot: ui.ThreadSnapshot | undefined) {
  const item = snapshot?.items.find((row) => row.item?.itemId === "stream")?.item;

  return item?.content.case === "agentMessage" ? item.content.value.text : "";
}
