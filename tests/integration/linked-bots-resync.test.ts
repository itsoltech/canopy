import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import type { ModelInput } from "../../apps/gateway/src/bots/types.ts";
import { setModules } from "./support/module-settings.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("linked bots survive home restarts and updates", () => {
  let a: TestGateway;
  let b: TestGateway;
  let la: LinkedComputers;
  let lb: LinkedComputers;
  let node: string;
  const ids: string[] = [];
  const previews = ["last message for main", "last message for work", "archived conversation"];

  const model = async (input: ModelInput) => ({
    text: input.messages.findLast((message) => message.role === "user")!.text,
    calls: [],
  });

  const qualified = (id: string) => qualifyId(id, node);
  let version = "0.2.0-nightly.119";
  let holdBotList: Promise<void> | undefined;

  function links(gateway: TestGateway) {
    const handlers = uiHandlers(gateway.core);

    const computers = linkedComputers({
      store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
      host: "127.0.0.1",
      heartbeatMs: 100,
      serve: remoteServe(
        {
          ...handlers,
          listBots: async (request, context) => {
            if (gateway === b) await holdBotList;

            return handlers.listBots(request, context);
          },
        },
        gateway.core,
      ),
    });

    if (gateway === b) {
      const hello = computers.hello.bind(computers);
      computers.hello = () => ({ ...hello(), appVersion: version });
    }

    gateway.core.computers = computers;
    gateway.core.network = computers.options.network;

    return computers;
  }

  const list = () => a.api.listBots({ includeArchived: true });

  const complete = (response: bots.ListBotsResponse) =>
    response.bots.length === ids.length &&
    ids.every(
      (id, index) => response.bots.find((bot) => bot.id === qualified(id))?.lastMessage?.text === previews[index],
    );

  async function ready() {
    expect(await eventually(async () => la.reachable().includes(node), Boolean, 15_000)).toBe(true);
  }

  async function mirrored() {
    expect(
      await eventually(async () => (await la.botMirror.conversations(node)).length === ids.length, Boolean, 15_000),
    ).toBe(true);
  }

  // A client follows the public overview feed and reads only on list invalidation, with no polling.
  function watch() {
    const abort = new AbortController();
    const updates: ui.OverviewUpdate[] = [];
    const snapshots: bots.ListBotsResponse[] = [];
    let error = "";

    const reading = (async () => {
      for await (const update of a.api.watchOverview({}, { signal: abort.signal })) {
        updates.push(update);

        if (
          update.change.case === "feeds" ||
          (update.change.case === "linkedReadCompleted" && update.change.value === "ListBots")
        )
          snapshots.push(await list());
      }
    })().catch((cause: Error) => {
      if (!abort.signal.aborted) error = cause.message;
    });

    return {
      updates,
      snapshots,
      error: () => error,
      close: async () => {
        abort.abort();
        await reading;
      },
    };
  }

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop", botModel: model });

    for (const [index, text] of previews.entries()) {
      const bot = (
        await b.api.createBot({
          clientRequestId: crypto.randomUUID(),
          configuration: {
            name: `Home bot ${index}`,
            shape: "round",
            color: "#22aaff",
            provider: Provider.CODEX,
            providerInstance: "native",
            model: "gpt-6.1-sol",
            workerId: b.workerId,
          },
        })
      ).bot!;

      ids.push(bot.id);
      await b.api.sendBotMessage({ botId: bot.id, text, clientRequestId: crypto.randomUUID() });

      if (index === 2) await b.api.archiveBot({ botId: bot.id });
    }

    la = links(a);
    lb = links(b);
    await la.start();
    await lb.start();
    node = lb.hello().nodeId;
    const invitation = await a.api.createComputerPairing({});
    await b.api.linkComputer({ address: la.addresses[0]!, code: invitation.code });
    await ready();
    await mirrored();
    const initial = await eventually(list, (response) => response.bots.length === ids.length, 15_000);
    expect(initial.bots.map((bot) => [bot.id, bot.lastMessage?.text])).toEqual(
      ids.map((id, index) => [qualified(id), previews[index]]),
    );
  }, 90_000);

  afterAll(async () => {
    await la?.close();
    await lb?.close();
    await a?.close();
    await b?.close();
  }, 30_000);

  test("a fresh online list uses the persisted mirror when the read cache is cold", async () => {
    // Bounded read caches can evict this key; restarting A also loses every in-memory read.
    la.reads.forget(node);
    expect(complete(await list())).toBe(true);
    expect((await a.api.listBots({})).bots.map((bot) => bot.id)).toEqual(ids.slice(0, 2).map(qualified));
  });

  test("a cached Working badge is cleared during loss and until the reachable home refreshes", async () => {
    const method = ui.GatewayService.method.listBots;
    const request = create(bots.ListBotsRequestSchema, { includeArchived: true });
    const id = qualified(ids[0]!);
    const snapshot = await list();
    const cached = snapshot.bots.find((bot) => bot.id === id)!;
    cached.executing = true;
    la.reads.remember(node, method, request, snapshot);
    expect((await list()).bots.find((bot) => bot.id === id)?.executing).toBe(true);

    const gate = Promise.withResolvers<void>();
    holdBotList = gate.promise;

    try {
      la.reads.disconnected(node);
      const away = await list();
      expect(away.unavailableComputers.map((peer) => peer.nodeId)).toContain(node);
      expect(away.bots.find((bot) => bot.id === id)?.executing).toBe(false);

      la.reads.connected(node);
      const refreshing = await list();
      expect(refreshing.refreshingComputers.map((peer) => peer.nodeId)).toContain(node);
      expect(refreshing.bots.find((bot) => bot.id === id)?.executing).toBe(false);
    } finally {
      holdBotList = undefined;
      gate.resolve();
      expect(
        await eventually(
          async () => la.reads.state(node, method, request),
          (state) => state === "fresh",
        ),
      ).toBe("fresh");
    }
  });

  for (const nextVersion of ["0.2.0-nightly.119", "0.2.0-nightly.121"]) {
    test(`a connected client and fresh loads retain previews across B restarting as ${nextVersion}`, async () => {
      const client = watch();

      try {
        expect(await eventually(async () => client.snapshots.some(complete), Boolean, 10_000)).toBe(true);
        await lb.close("restarting");
        await b.close(true);
        expect(await eventually(async () => !la.reachable().includes(node), Boolean, 10_000)).toBe(true);
        expect(complete(await list())).toBe(true);
        expect(await failure(a.api.sendBotMessage({ botId: qualified(ids[0]!), text: "offline" }))).toBeTruthy();
        const before = client.snapshots.length;
        version = nextVersion;
        b = await startTestGateway({ role: "desktop", botModel: model, storage: b });
        lb = links(b);
        await lb.start();
        await ready();
        expect(await eventually(async () => client.snapshots.slice(before).some(complete), Boolean, 15_000)).toBe(true);
        expect(client.snapshots.every(complete)).toBe(true);
        expect(client.error()).toBe("");
        expect((await a.api.getComputers({})).peers.find((peer) => peer.nodeId === node)?.appVersion).toBe(nextVersion);
        expect(complete(await list())).toBe(true);
        const abort = new AbortController();

        try {
          for await (const conversation of a.api.watchBotConversation(
            { botId: qualified(ids[0]!) },
            { signal: abort.signal },
          )) {
            expect(conversation.bot?.lastMessage?.text).toBe(previews[0]);
            break;
          }
        } finally {
          abort.abort();
        }
      } finally {
        await client.close();
      }
    }, 45_000);
  }

  test("updating A restores an already-empty client list without a new bot message", async () => {
    await la.close("restarting");
    await a.close(true);
    a = await startTestGateway({ role: "desktop", storage: a });
    la = links(a);
    await la.start();
    await ready();
    const client = watch();

    try {
      expect(complete(await list())).toBe(true);
      expect(await eventually(async () => client.snapshots.some(complete), Boolean, 15_000)).toBe(true);
      expect(client.snapshots.every(complete)).toBe(true);
      expect(client.error()).toBe("");
      await mirrored();
    } finally {
      await client.close();
    }
  }, 45_000);

  test("the mirror reconciles deletions, archives and previews changed while B was away", async () => {
    const client = watch();

    try {
      expect(await eventually(async () => client.snapshots.some(complete), Boolean, 10_000)).toBe(true);
      await lb.close("updating");
      expect(await eventually(async () => !la.reachable().includes(node), Boolean, 10_000)).toBe(true);
      expect(complete(await list())).toBe(true);
      const removed = ids.shift()!;
      previews.shift();
      await b.api.deleteBot({ botId: removed });
      await b.api.sendBotMessage({ botId: ids[0]!, text: "changed while away", clientRequestId: crypto.randomUUID() });
      previews[0] = "changed while away";
      await b.api.archiveBot({ botId: ids[0]! });
      await b.api.unarchiveBot({ botId: ids[1]! });
      // A new home runtime has no in-memory bot removals to replay to A's existing watch.
      await b.close(true);
      b = await startTestGateway({ role: "desktop", botModel: model, storage: b });
      lb = links(b);
      const before = client.snapshots.length;
      await lb.start();
      await ready();
      expect(await eventually(async () => client.snapshots.slice(before).some(complete), Boolean, 15_000)).toBe(true);
      expect(complete(await list())).toBe(true);
      expect((await list()).bots.some((bot) => bot.id === qualified(removed))).toBe(false);
      const activeId = qualified(ids[1]!);
      // The filtered list has its own background cache; the inclusive list can refresh first.
      expect(
        await eventually(
          async () => (await a.api.listBots({})).bots.map((bot) => bot.id),
          (active) => active.length === 1 && active[0] === activeId,
          15_000,
        ),
      ).toEqual([activeId]);
      expect(client.error()).toBe("");
      await mirrored();
    } finally {
      await client.close();
    }
  }, 45_000);

  test("either home can pause a history mirror and recover its cursor when the module returns", async () => {
    const botId = ids.at(-1)!;

    const preview = async () =>
      (await la.botMirror.conversations(node)).find((entry) => entry.bot?.id === qualified(botId))?.bot?.lastMessage
        ?.text;

    let expected = await preview();
    expect(expected).toBeTruthy();
    const watches = () => [la.diagnosticsWatches(), lb.diagnosticsWatches()];

    for (const [gateway, keep] of [
      [a, "threads"],
      [b, "bots"],
    ] as const) {
      await setModules(gateway, keep);

      try {
        expect(
          await eventually(
            async () => watches(),
            (counts) => counts.every((n) => n === 1),
          ),
        ).toEqual([1, 1]);

        if (keep === "threads") {
          const text = "sent while the subscriber paused Bots";
          await b.api.sendBotMessage({ botId, text, clientRequestId: crypto.randomUUID() });
          expect(await preview()).toBe(expected);
          expected = text;
        }
      } finally {
        await setModules(gateway, "threads", "bots");
      }

      expect(
        await eventually(
          async () => watches(),
          (counts) => counts.every((n) => n === 2),
        ),
      ).toEqual([2, 2]);
      expect(await eventually(preview, (text) => text === expected, 10_000)).toBe(expected);
    }
  }, 30_000);
});
