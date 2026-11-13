import { expect, test } from "bun:test";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";

test.skipIf(!dockerAvailable)(
  "remote sequence watch stays readable offline and recovers when its home returns",
  async () => {
    const a = await startTestGateway({ role: "desktop", watchProbeMs: 100 });
    const b = await startTestGateway({ role: "desktop", watchProbeMs: 100 });
    const source = new ComputerStore(b.runtime, b.userId, b.secretsKey);

    const local = linkedComputers({
      store: new ComputerStore(a.runtime, a.userId, a.secretsKey),
      core: a.core,
      host: "127.0.0.1",
      serve: remoteServe(uiHandlers(a.core)),
    });

    const homeOptions = { store: source, core: b.core, host: "127.0.0.1", serve: remoteServe(uiHandlers(b.core)) };
    let home = linkedComputers(homeOptions);
    const abort = new AbortController();

    try {
      a.core.computers = local;
      b.core.computers = home;
      const project = (await b.api.createProject({ name: "Remote sequence watch" })).project!.id;

      const workspace = (
        await b.api.createWorkspace({ projectId: project, workerId: b.workerId, rootPath: "/repo/remote-watch" })
      ).workspace!.id;

      const thread = (
        await b.api.createThread({
          projectId: project,
          workspaceId: workspace,
          provider: Provider.CODEX,
          title: "Cached home",
          clientRequestId: crypto.randomUUID(),
        })
      ).thread!.id;

      const itemId = crypto.randomUUID();
      await source.query(
        `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      VALUES($1::uuid,$2,'agentMessage','completed',$3::jsonb,1,1)`,
        [thread, itemId, JSON.stringify({ itemId, agentMessage: { text: "Saved message" } })],
      );
      await local.start();
      await home.start();
      await home.pair(local.addresses[0]!, (await local.createPairing()).code);
      const node = home.hello().nodeId;
      const id = qualifyId(thread, node);
      expect(
        await eventually(
          async () => (await local.mirror.snapshot(node, thread))?.items.length,
          (count) => count === 1,
          10000,
        ),
      ).toBe(1);
      let cached: ui.ThreadSnapshot | undefined;

      for await (const update of a.api.watchThread(
        { threadId: id, sequence: true },
        { signal: abort.signal, timeoutMs: 5000 },
      )) {
        cached = applyThreadUpdate(cached, update);

        if (update.change.case === "snapshot") break;
      }

      expect(cached?.thread?.id).toBe(id);
      expect(cached?.syncCursor?.threadId).toBe(id);
      const headsAbort = new AbortController();

      try {
        for await (const update of a.api.watchOverview(
          { threadHeadIds: [id] },
          { signal: headsAbort.signal, timeoutMs: 5000 },
        )) {
          if (update.change.case !== "threadHeads") continue;
          expect(update.change.value.heads[0]?.threadId).toBe(id);
          expect(update.change.value.heads[0]?.epoch).toBe(cached?.syncCursor?.epoch);
          break;
        }
      } finally {
        headsAbort.abort();
      }

      await b.api.updateThread({ threadId: thread, title: "Warmed through the linked home" });

      for await (const update of a.api.watchThread(
        { threadId: id, sequence: true, background: true, syncCursor: cached?.syncCursor },
        { timeoutMs: 5000 },
      )) {
        expect(update.change.case).toBe("batch");
        cached = applyThreadUpdate(cached, update);
      }

      expect(cached?.thread?.title).toBe("Warmed through the linked home");
      await home.close();
      expect(await eventually(async () => !local.reachable().includes(node), Boolean)).toBe(true);
      expect((await a.api.getOverview({})).workers.length).toBeGreaterThan(0);

      const offline = a.api.watchThread(
        { threadId: id, sequence: true, syncCursor: cached?.syncCursor },
        { signal: abort.signal, timeoutMs: 15000 },
      );

      let reason = "";

      for await (const update of offline) {
        cached = applyThreadUpdate(cached, update);
        reason = update.syncStatus?.reason ?? "";
        expect(cached.items[0]?.item?.content.case).toBe("agentMessage");
        expect(reason).toBe("computer_unreachable");
        // The watch ends on presence recovery, allowing the client to resume automatically.
        home = linkedComputers(homeOptions);
        b.core.computers = home;
        await home.start();
      }

      expect(reason).toBe("computer_unreachable");
      expect(await eventually(async () => local.reachable().includes(node), Boolean, 10000)).toBe(true);
      await b.api.updateThread({ threadId: thread, title: "Home recovered" });

      for await (const update of a.api.watchThread(
        { threadId: id, sequence: true, syncCursor: cached?.syncCursor },
        { signal: abort.signal, timeoutMs: 10000 },
      )) {
        cached = applyThreadUpdate(cached, update);

        if (cached.thread?.title === "Home recovered") break;
      }

      expect(cached?.thread?.title).toBe("Home recovered");
      expect((await local.computer(node))?.status).toBe("connected");
    } finally {
      abort.abort();
      await local.close();
      await home.close();
      await a.close();
      await b.close();
    }
  },
  40000,
);
