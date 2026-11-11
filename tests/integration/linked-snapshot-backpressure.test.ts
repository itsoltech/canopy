import { describe, expect, test } from "bun:test";
import { create, toJson } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, Provider, ui } from "@canopy/contracts";
import { linkedMessage } from "../../apps/gateway/src/computers/remote.ts";
import { discoverCertificate } from "../../apps/gateway/src/computers/transport.ts";
import { certificateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("large initial mirrors over real gateway links", () => {
  test("a large timeline converges without retiring the shared connection", async () => {
    const a = await startTestGateway({ role: "desktop" });
    const b = await startTestGateway({ role: "desktop" });
    const sa = new ComputerStore(a.runtime, a.userId, a.secretsKey);
    const sb = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    const local = linkedComputers({ store: sa, host: "127.0.0.1", serve: remoteServe(uiHandlers(a.core)) });
    const home = linkedComputers({ store: sb, host: "127.0.0.1", serve: remoteServe(uiHandlers(b.core)) });

    try {
      const project = (await b.api.createProject({ name: "Large mirror" })).project!.id;

      const workspace = (
        await b.api.createWorkspace({ projectId: project, workerId: b.workerId, rootPath: "/repo/large" })
      ).workspace!.id;

      const thread = (
        await b.api.createThread({
          projectId: project,
          workspaceId: workspace,
          provider: Provider.CODEX,
          title: "Large history",
          clientRequestId: crypto.randomUUID(),
        })
      ).thread!.id;

      const item = create(ItemSchema, {
        status: ItemStatus.COMPLETED,
        content: { case: "commandExecution", value: { command: "bun test", output: "x".repeat(32_700) } },
      });

      await sb.query(
        `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
        SELECT $1::uuid,'item-' || n,'commandExecution','completed',
        $2::jsonb || jsonb_build_object('itemId','item-' || n),n,n FROM generate_series(1,3000) n`,
        [thread, JSON.stringify(toJson(ItemSchema, item))],
      );
      await sb.query("UPDATE threads SET last_seq=3000 WHERE id=$1::uuid", [thread]);
      a.core.computers = local;
      a.core.network = local.options.network;
      b.core.computers = home;
      b.core.network = home.options.network;
      await local.start();
      await home.start();
      const node = home.hello().nodeId;
      let subscribed = 0;
      const publish = home.mirror.publish.bind(home.mirror);
      home.mirror.publish = async function* (...args) {
        subscribed++;
        yield* publish(...args);
      };

      await home.pair(local.addresses[0]!, (await local.createPairing()).code);
      expect(await eventually(async () => Boolean((await local.mirror.state(node))?.cursor), Boolean, 20_000)).toBe(
        true,
      );
      const snapshot = (await local.mirror.snapshot(node, thread))!;
      expect(snapshot.items).toHaveLength(3000);
      expect(snapshot.items.at(-1)?.item?.content.case).toBe("commandExecution");
      const cursor = (await local.mirror.state(node))!.cursor;
      await b.api.updateThread({ threadId: thread, title: "Updated after the large bootstrap" });
      expect(await eventually(async () => (await local.mirror.state(node))?.cursor !== cursor, Boolean, 10_000)).toBe(
        true,
      );
      expect((await local.mirror.snapshot(node, thread))?.items).toHaveLength(3000);
      expect((await local.mirror.thread(node, thread))?.title).toBe("Updated after the large bootstrap");

      // Certificate discovery is a separate session and must not retire the live mirror's session.
      await discoverCertificate(
        local.addresses[0]!,
        certificateIdentity(local.identity.certificate).fingerprint,
        home.identity,
      );

      for await (const response of local.remote(
        node,
        ui.GatewayService.method.getOverview,
        create(ui.GetOverviewRequestSchema),
        AbortSignal.timeout(5000),
      )) {
        expect(linkedMessage(ui.GetOverviewResponseSchema, response).projects.some((p) => p.id === project)).toBe(true);
        break;
      }

      expect(subscribed).toBe(1);
      expect(local.canCall(node)).toBe(true);
      expect((await local.computer(node))?.status).toBe("connected");
    } finally {
      await Promise.allSettled([local.close(), home.close()]);
      await a.close();
      await b.close();
    }
  }, 90_000);
});
