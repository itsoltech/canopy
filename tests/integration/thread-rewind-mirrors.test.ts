import { expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { GatewayStore } from "@canopy/gateway/store";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";

test.skipIf(!dockerAvailable)(
  "rewind and undo converge on a linked mirror by seq after reconnect",
  async () => {
    const a = await startTestGateway({ role: "desktop" });
    const b = await startTestGateway({ role: "desktop", worker: { hello: { capabilities: ["thread_rewind_v1"] } } });
    const source = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    const target = new ComputerStore(a.runtime, a.userId, a.secretsKey);

    const local = linkedComputers({
      store: target,
      core: a.core,
      host: "127.0.0.1",
      serve: remoteServe(uiHandlers(a.core)),
    });

    const makeHome = () =>
      linkedComputers({ store: source, core: b.core, host: "127.0.0.1", serve: remoteServe(uiHandlers(b.core)) });

    let home = makeHome();

    try {
      a.core.computers = local;
      a.core.network = local.options.network;
      b.core.computers = home;
      b.core.network = home.options.network;
      const projectId = (await b.api.createProject({ name: "Rewind mirror" })).project!.id;

      const workspaceId = (
        await b.api.createWorkspace({ projectId, workerId: b.workerId, rootPath: "/repo/rewind-mirror" })
      ).workspace!.id;

      const thread = (
        await b.api.createThread({
          projectId,
          workspaceId,
          provider: Provider.CODEX,
          initialMessage: "KEEP",
          clientRequestId: "create",
        })
      ).thread!;

      const turns = () => b.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(thread.id)));
      await eventually(turns, (rows) => rows[0]?.status === "completed");
      const sent = (await b.api.sendMessage({ threadId: thread.id, text: "REWIND", clientRequestId: "second" })).turn!;
      await eventually(turns, (rows) => rows[1]?.status === "completed");
      await local.start();
      await home.start();
      const node = home.hello().nodeId;
      await home.pair(local.addresses[0]!, (await local.createPairing()).code);

      const mirrored = async () => {
        const rows = await target.query<{ payload: Uint8Array }>(
          `SELECT payload FROM thread_range_entities
        WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid AND kind='turn'`,
          [a.userId, node, thread.id],
        );

        return rows.flatMap((row) => {
          const record = fromBinary(ui.ThreadSyncRecordSchema, row.payload);

          return record.value.case === "turn" ? [record.value.value] : [];
        });
      };

      await eventually(mirrored, (rows) => rows.length === 2, 15_000);
      const before = (await local.ranges.cursors(node)).find((cursor) => cursor.threadId === thread.id)!;

      const result = await a.api.rewindThread({
        threadId: qualifyId(thread.id, node),
        turnId: qualifyId(sent.id, node),
        clientRequestId: "linked-edit",
      });

      expect(result.status).toBe("completed");
      await eventually(mirrored, (rows) => rows.some((turn) => turn.id === sent.id && Boolean(turn.rewindId)), 15_000);
      const after = (await local.ranges.cursors(node)).find((cursor) => cursor.threadId === thread.id)!;
      expect(after.epoch).toBe(before.epoch);
      expect(after.appliedSeq).toBeGreaterThan(before.appliedSeq);
      await home.close();
      await b.api.restoreThreadRewind({ threadId: thread.id, rewindId: (await turns())[1]!.rewind_id! });
      home = makeHome();
      b.core.computers = home;
      b.core.network = home.options.network;
      const batches: ui.ThreadSyncBatch[] = [];
      const publish = home.rangePublisher.publish.bind(home.rangePublisher);
      home.rangePublisher.publish = async function* (...args) {
        for await (const update of publish(...args)) {
          if (update.rangeBatch?.threadId === thread.id) batches.push(update.rangeBatch);
          yield update;
        }
      };

      await home.start();
      await eventually(mirrored, (rows) => rows.length === 2 && rows.every((turn) => !turn.rewindId), 20_000);
      expect(batches.length).toBeGreaterThan(0);
      expect(batches.every((batch) => batch.epoch === before.epoch && batch.baseSeq >= after.appliedSeq)).toBe(true);
    } finally {
      await home.close();
      await local.close();
      await b.close();
      await a.close();
    }
  },
  60_000,
);
