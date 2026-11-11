import { expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { REMOTE_THREADS, THREAD_MIRROR, THREAD_MIRROR_DELTA, THREAD_RANGES } from "@canopy/domain/computers";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";

test.skipIf(!dockerAvailable).each(["home", "subscriber"])(
  "sequence mirror interoperates with a legacy %s",
  async (legacySide) => {
    const a = await startTestGateway({ role: "desktop" });
    const b = await startTestGateway({ role: "desktop" });
    const sa = new ComputerStore(a.runtime, a.userId, a.secretsKey);
    const sb = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    const legacy = ["presence", "unlink", REMOTE_THREADS, THREAD_MIRROR, THREAD_MIRROR_DELTA];

    const local = linkedComputers({
      store: sa,
      core: a.core,
      host: "127.0.0.1",
      serve: remoteServe(uiHandlers(a.core)),
      ...(legacySide === "subscriber" && { capabilities: legacy }),
    });

    const home = linkedComputers({
      store: sb,
      core: b.core,
      host: "127.0.0.1",
      serve: remoteServe(uiHandlers(b.core)),
      ...(legacySide === "home" && { capabilities: legacy }),
    });

    let rangeCalls = 0;
    home.rangePublisher.publish = () => {
      rangeCalls++;
      throw new Error("Legacy peer requested sequence ranges");
    };

    try {
      a.core.computers = local;
      b.core.computers = home;
      const project = (await b.api.createProject({ name: "Compatibility" })).project!.id;

      const workspace = (
        await b.api.createWorkspace({ projectId: project, workerId: b.workerId, rootPath: "/repo/compat" })
      ).workspace!.id;

      const thread = (
        await b.api.createThread({
          projectId: project,
          workspaceId: workspace,
          provider: Provider.CODEX,
          title: "Compatibility",
          clientRequestId: crypto.randomUUID(),
        })
      ).thread!.id;

      await sb.query(
        `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      VALUES($1::uuid,'future-item','agent_message','completed',$2::jsonb,1,1)`,
        [
          thread,
          JSON.stringify({
            itemId: "future-item",
            status: "COMPLETED",
            agentMessage: { text: "Supported field" },
            futureField: { version: 2 },
          }),
        ],
      );
      await local.start();
      await home.start();
      await home.pair(local.addresses[0]!, (await local.createPairing()).code);
      const node = home.hello().nodeId;
      expect(legacySide === "home" ? local.hello().capabilities : home.hello().capabilities).toContain(THREAD_RANGES);
      expect(
        await eventually(
          async () => (await local.mirror.snapshot(node, thread))?.items.length,
          (count) => count === 1,
          15_000,
        ),
      ).toBe(1);
      expect(rangeCalls).toBe(0);
      await b.api.updateThread({ threadId: thread, title: "Live legacy update" });
      expect(
        await eventually(
          async () => (await local.mirror.thread(node, thread))?.title,
          (title) => title === "Live legacy update",
          10_000,
        ),
      ).toBe("Live legacy update");
      expect((await local.computer(node))?.status).toBe("connected");
    } finally {
      await Promise.allSettled([local.close(), home.close()]);
      await a.close();
      await b.close();
    }
  },
  30_000,
);
