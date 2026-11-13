import { expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { startTestGateway } from "./support/gateway.ts";
import { FeedBuilder } from "../../apps/web/src/lib/features/threads/feed.ts";
import { prefetchWorkHistory } from "../../apps/web/src/lib/features/threads/work-history.ts";
import { threadCacheTail } from "@canopy/domain/thread-cache-tail";
import { prependThreadPage } from "@canopy/domain/history-pages";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { dockerAvailable } from "@canopy/db/testing";

test.skipIf(!dockerAvailable)(
  "bounded foreground and persisted windows prefetch missing work without losing their checkpoint",
  async () => {
    const gateway = await startTestGateway();

    try {
      const store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
      const project = (await gateway.api.createProject({ name: "Work windows" })).project!.id;

      const workspace = (
        await gateway.api.createWorkspace({ projectId: project, workerId: gateway.workerId, rootPath: "/repo/windows" })
      ).workspace!.id;

      const thread = (
        await gateway.api.createThread({ projectId: project, workspaceId: workspace, provider: Provider.CODEX })
      ).thread!.id;

      await store.query(
        `INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input,first_seq,last_seq)
      SELECT md5($1 || ':' || n)::uuid,$1::uuid,n,'completed','user',$2::uuid,jsonb_build_object('text','Turn ' || n),n*200-199,n*200
      FROM generate_series(1,3) n`,
        [thread, gateway.userId],
      );
      await store.query(
        `INSERT INTO thread_items(thread_id,item_id,turn_id,type,status,content,first_seq,last_seq)
      SELECT $1::uuid,'item-' || n,md5($1 || ':' || ((n+199)/200))::uuid,'agentMessage','completed',
        jsonb_build_object('itemId','item-' || n,'agentMessage',jsonb_build_object('text','Saved message')),n,n
      FROM generate_series(1,600) n`,
        [thread],
      );

      const read = async (base?: ui.ThreadSnapshot) => {
        const abort = new AbortController();

        try {
          for await (const update of gateway.api.watchThread(
            {
              threadId: thread,
              pageSize: 24,
              sequence: true,
              beforeTurnId: base?.historyBeforeTurnId ?? "",
              beforeItemId: base?.historyBeforeItemId ?? "",
              historyVersion: base?.historyVersion ?? "",
            },
            { signal: abort.signal, timeoutMs: 15000 },
          )) {
            if (update.change.case === "snapshot") return update.change.value;
          }

          throw new Error("Missing bounded window");
        } finally {
          abort.abort();
        }
      };

      const feed = (snapshot: ui.ThreadSnapshot) =>
        new FeedBuilder().build({
          entries: snapshot.items.flatMap((entry) =>
            entry.item
              ? [
                  {
                    id: entry.item.itemId,
                    turnId: entry.turnId,
                    firstSeq: entry.firstSeq,
                    item: entry.item,
                    fromThreadId: entry.fromThreadId,
                    inherited: entry.inherited,
                  },
                ]
              : [],
          ),
          turns: snapshot.turns,
          notices: [],
          results: new Map(),
          steering: [],
          working: false,
          inheritedEntries: [],
          inheritedTurns: [],
          historyOpen: false,
          openWork: new Set(),
          historyItemsHasMore: snapshot.historyItemsHasMore,
        });

      const initial = await read();
      expect(initial.items).toHaveLength(128);
      expect(initial.turns).toHaveLength(3);
      let state = fromBinary(ui.ThreadSnapshotSchema, toBinary(ui.ThreadSnapshotSchema, threadCacheTail(initial)));
      const checkpoint = state.cursor;
      const gaps = feed(state).filter((row) => row.kind === "work-gap");
      expect(gaps).toHaveLength(3);

      for (const gap of gaps.slice(0, -1))
        expect(feed(state).some((row) => row.key === `work:${gap.turn.id}`)).toBe(false);
      state = applyThreadUpdate(
        state,
        create(ui.ThreadUpdateSchema, {
          change: {
            case: "batch",
            value: {
              threadId: thread,
              epoch: state.syncCursor!.epoch,
              baseSeq: state.syncCursor!.appliedSeq,
              appliedSeq: state.syncCursor!.appliedSeq,
              headSeq: state.syncCursor!.appliedSeq,
              caughtUp: true,
            },
          },
        }),
      );
      expect(feed(state).filter((row) => row.kind === "work-gap")).toHaveLength(3);

      for (let count = 0; count < 8; count++) {
        const rows = feed(state);

        if (!prefetchWorkHistory(rows, 0, rows.length)) break;
        const page = await read(state);
        expect(page.items.length).toBeLessThanOrEqual(128);
        state = prependThreadPage(state, page, checkpoint);
        expect(state.cursor).toBe(checkpoint);
      }

      expect(state.items).toHaveLength(600);
      expect(state.historyItemsHasMore).toBe(false);
      expect(feed(state).some((row) => row.kind === "work-gap")).toBe(false);
      expect(feed(state).filter((row) => row.kind === "answer" && row.row)).toHaveLength(3);
    } finally {
      await gateway.close();
    }
  },
  60000,
);
