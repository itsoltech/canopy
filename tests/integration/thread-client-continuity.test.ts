import { expect, test } from "bun:test";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { mobileClient } from "../../apps/mobile/src/api/client.ts";
import { startConnectHttpServer } from "@canopy/transport";
import { uiHandlers } from "@canopy/gateway/api";
import { ThreadWatchLiveness, THREAD_STALL_MS } from "@canopy/domain/thread-watch-liveness";
import { ThreadWarmer } from "@canopy/domain/thread-warmer";
import { RetainedThreads } from "@canopy/domain/retained-threads";
import { THREAD_WARM_LIMITS } from "@canopy/domain/thread-warm-set";
import { overviewThreadHeads } from "../../apps/gateway/src/core/overview-thread-heads.ts";
import { startTestGateway, eventually } from "./support/gateway.ts";
import { followThread } from "./support/thread-watch.ts";
import { webThreadClient } from "./support/web-thread-client.ts";

test.skipIf(!dockerAvailable)(
  "desktop keeps remote and local turns across drops, retention, warming and a stalled live watch",
  async () => {
    const gateway = await startTestGateway({ watchProbeMs: 100 });

    const mobileServer = await startConnectHttpServer({
      routes: (router) => router.service(ui.GatewayService, uiHandlers(gateway.core)),
    });

    const phone = mobileClient({ gatewayUrl: mobileServer.url, development: true, fetch }).api;
    const desktop = webThreadClient(gateway.api);
    const abort = new AbortController();

    const retained = new RetainedThreads<typeof desktop>({
      count: 2,
      bytes: 1024 * 1024,
      idle: (run) => {
        run();

        return () => {};
      },
    });

    let warmer: ThreadWarmer | undefined;

    try {
      const projectId = (await gateway.api.createProject({ name: "Client continuity" })).project!.id;

      const workspaceId = (
        await gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath: "/repo/continuity" })
      ).workspace!.id;

      const id = (await gateway.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!.id;
      await eventually(
        () => gateway.api.getThread({ threadId: id }),
        (r) => r.thread?.status === "idle",
      );

      const mobile = await followThread(
        phone.watchThread({ threadId: id, sequence: true }, { signal: abort.signal }),
        abort,
      );

      retained.open(id, () => desktop);
      let hide = retained.show(id);
      desktop.open(id);
      await eventually(async () => desktop.live, Boolean);

      const send = async (api: typeof phone, text: string) => {
        const turn = (await api.sendMessage({ threadId: id, text, clientRequestId: crypto.randomUUID() })).turn!;
        await mobile.until((state) => state.turns.some((t) => t.id === turn.id && t.status === "completed"));

        return turn;
      };

      const visible = async (turn: ui.Turn) => {
        await eventually(
          async () => desktop.snapshot,
          (state) => !!state?.items.some((item) => item.item?.itemId === `msg-${turn.id}`),
        );
        const rows = desktop.rows();
        expect(
          rows.some((row) => row.kind === "timeline" && row.row.kind === "input" && row.row.turn.id === turn.id),
        ).toBe(true);
        expect(
          rows.some(
            (row) => row.kind === "answer" && row.row?.kind === "item" && row.row.node.entry.turnId === turn.id,
          ),
        ).toBe(true);
      };

      await visible(await send(phone, "Sent from the phone"));

      // Three short network losses used to consume the scoped failure budget and permanently stop EventSource.
      for (let index = 0; index < 3; index++) {
        const received = desktop.received;
        const requests = desktop.requests.length;
        const sent = index === 2 ? send(gateway.api, "Local send during a connection drop") : undefined;
        desktop.dropTransport();
        desktop.wake();
        expect(await eventually(async () => desktop.received > received && desktop.live, Boolean)).toBe(true);
        expect(desktop.requests.length).toBeGreaterThan(requests);

        if (sent) await visible(await sent);
      }

      await visible(await send(phone, "After desktop sleep and network changes"));
      const before = desktop.snapshots;
      const cursor = desktop.snapshot!.cursor;

      // Switch away; the background job advances the retained snapshot while no visible watch exists.
      desktop.disconnect();
      hide();
      const remote = await send(phone, "While the desktop shows another thread");
      warmer = new ThreadWarmer(
        {
          peek: (key) => retained.snapshot(key),
          load: async (key) => retained.snapshot(key),
          save: (snapshot, replaced) => {
            expect(retained.refresh(snapshot, replaced)).toBe(true);
          },
        },
        (threadId, syncCursor, signal) =>
          gateway.api.watchThread({ threadId, syncCursor, sequence: true, background: true }, { signal }),
        { ...THREAD_WARM_LIMITS, intervalMs: 20, requested: () => {} },
      );
      warmer.select([id]);
      warmer.heads((await overviewThreadHeads(gateway.core, [id])).heads);
      warmer.enable(true);
      expect(await eventually(async () => desktop.snapshot?.cursor !== cursor, Boolean)).toBe(true);
      warmer.close();
      hide = retained.show(id);
      desktop.open(id);
      await eventually(async () => desktop.live, Boolean);
      await visible(remote);
      await visible(await send(gateway.api, "Sent locally while the phone watches"));

      // An apparently open transport can be silent. Overview evidence repairs from the view's own cursor.
      desktop.stall();
      const received = desktop.received;
      const missed = await send(phone, "During a silent desktop stream stall");
      const head = (await overviewThreadHeads(gateway.core, [id])).heads[0]!;
      const guard = new ThreadWatchLiveness();
      const applied = desktop.snapshot!.syncCursor;
      expect(desktop.live).toBe(true);
      expect(desktop.received).toBe(received);
      expect(guard.check(applied, head, 0)).toBeUndefined();
      expect(guard.check(applied, head, THREAD_STALL_MS - 1)).toBeUndefined();
      expect(guard.check(applied, head, THREAD_STALL_MS)).toEqual({ lagMs: THREAD_STALL_MS, attempt: 1 });
      desktop.open(id);
      await visible(missed);
      expect(desktop.requests.at(-1)).toBe(`range:${applied!.epoch}:${applied!.appliedSeq}`);
      expect(desktop.snapshots).toBe(before);
      hide();
      await mobile.close();
    } finally {
      warmer?.close();
      abort.abort();
      retained.clear();
      await desktop.close();
      await mobileServer.close();
      await gateway.close();
    }
  },
  60_000,
);
