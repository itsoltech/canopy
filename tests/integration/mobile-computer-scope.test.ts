import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { sharedHost, uiHandlers } from "@canopy/gateway/api";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { linkedComputers } from "./support/computers.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { failure, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("phone administration of linked computers is owner-scoped", () => {
  let gw: TestGateway;
  let store: ComputerStore;
  let computers: LinkedComputers;
  let unmount: () => void;

  beforeAll(async () => {
    gw = await startTestGateway({ role: "desktop" });
    store = new ComputerStore(gw.runtime, gw.userId, gw.secretsKey);
    computers = linkedComputers({
      store,
      host: "127.0.0.1",
      core: gw.core,
      shared: sharedHost(gw.core, uiHandlers(gw.core)),
    });
    gw.core.computers = computers;
    gw.core.network = computers.options.network;
    unmount = mountMobileNetwork(gw.core, computers.options.network, SERVICE_TOKEN);
    await computers.start();
  }, 60_000);
  afterAll(async () => {
    unmount?.();
    await computers?.close();
    await gw?.close();
  });

  test("foreign computer and configuration notice ids are hidden and cannot be changed", async () => {
    const invitation = await gw.api.createMobilePairing({});
    const connection = gw.core.mobile.networkRoutes();
    const transport = nodePinnedTransport();

    const pairing = await routedMobileClient({ connection, transport }).pairing.exchangeMobilePairing({
      code: invitation.code,
      name: "Owner phone",
      platform: "android",
    });

    const phone = routedMobileClient({ connection, transport, token: pairing.deviceToken }).api;
    const owner = crypto.randomUUID();
    const peer = await generateIdentity();
    const notice = crypto.randomUUID();
    await store.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other','user')", [
      owner,
      `${owner}@example.test`,
    ]);
    await store.query(
      "INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint) VALUES($1::uuid,$2,'Other computer',$3,$4)",
      [owner, peer.nodeId, peer.certificate, peer.fingerprint],
    );
    await store.query(
      `INSERT INTO config_history(id,owner_user_id,kind,global_id,field,value,hlc,node_id,notice_node_id)
       VALUES($1::uuid,$2::uuid,'settings','account','time_zone','"Other value"',$4,$3,$3)`,
      [notice, owner, peer.nodeId, `${Date.now()}.0.${peer.nodeId}`],
    );
    const listed = await phone.getComputers({});
    expect(listed.peers.some((p) => p.nodeId === peer.nodeId)).toBe(false);
    expect(listed.configNotices.some((n) => n.id === notice)).toBe(false);

    for (const action of ["rename", "unlink", "add_route", "remove_route", "share_config"])
      expect(
        await failure(
          phone.manageComputer({
            action,
            nodeId: peer.nodeId,
            name: "Changed",
            address: "https://example.invalid:23456",
            enabled: false,
          }),
        ),
      ).toContain("not found");

    const ownNotice = crypto.randomUUID();
    await store.query(
      `INSERT INTO config_history(id,owner_user_id,kind,global_id,field,value,hlc,node_id,notice_node_id)
       SELECT $1::uuid,$2::uuid,kind,global_id,field,value,hlc,node_id,notice_node_id FROM config_history WHERE id=$3::uuid`,
      [ownNotice, gw.userId, notice],
    );
    expect((await phone.getComputers({})).configNotices.some((n) => n.id === ownNotice)).toBe(true);
    await phone.manageConfigNotice({ id: ownNotice, action: "dismiss" });
    expect((await store.query("SELECT state FROM config_history WHERE id=$1::uuid", [ownNotice]))[0]).toMatchObject({
      state: "dismissed",
    });

    for (const action of ["restore", "dismiss"]) {
      const missing = await failure(phone.manageConfigNotice({ id: crypto.randomUUID(), action }));
      expect(await failure(phone.manageConfigNotice({ id: notice, action }))).toBe(missing);
    }

    expect(
      (
        await store.query(
          "SELECT name,display_name,share_config FROM computer_peers WHERE owner_user_id=$1::uuid AND node_id=$2",
          [owner, peer.nodeId],
        )
      )[0],
    ).toMatchObject({ name: "Other computer", display_name: "", share_config: true });
    expect((await store.query("SELECT state,value FROM config_history WHERE id=$1::uuid", [notice]))[0]).toMatchObject({
      state: "open",
      value: "Other value",
    });
    expect(
      await store.query("SELECT 1 FROM computer_routes WHERE owner_user_id=$1::uuid AND node_id=$2", [
        owner,
        peer.nodeId,
      ]),
    ).toHaveLength(0);
  });
});
