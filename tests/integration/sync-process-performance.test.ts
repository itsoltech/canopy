import { expect, test } from "bun:test";
import { Schema } from "effect";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { SERVICE_TOKEN } from "./support/gateway.ts";
import { scenarioWatch } from "./support/sync-scenario.ts";
import { decodeInfo, syncProcess } from "./support/sync-process.ts";

const Connection = Schema.Struct({
  fingerprint: Schema.String,
  addresses: Schema.mutable(Schema.Array(Schema.String)),
});

/** Opt-in three-process profile; reports interval CPU separately from startup/teardown. */
test.skipIf(!dockerAvailable || process.env["CANOPY_SYNC_PROCESSES"] !== "1")(
  "isolated sync CPU scenario",
  async () => {
    const viewer = syncProcess("viewer");
    const home = syncProcess("home");
    const bff = syncProcess("bff");
    const abort = new AbortController();
    const readers: Promise<void>[] = [];

    const api = (url: string) =>
      createClient(
        ui.GatewayService,
        createGrpcTransport({
          baseUrl: url,
          interceptors: [
            (next) => (request) => {
              request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

              return next(request);
            },
          ],
        }),
      );

    try {
      const a = decodeInfo(await viewer.run("info"));
      const b = decodeInfo(await home.run("info"));
      await home.run("pair", { url: a.address, code: await viewer.run("invitation") });
      await viewer.run("mirror", { node: b.node, threads: [b.threads[0]!], code: "Scenario 0" });
      await home.run("mirror", { node: a.node, threads: [a.threads[0]!], code: "Scenario 0" });
      const viewApi = api(a.url);
      const homeApi = api(b.url);
      const views = [];

      for (const [client, remote] of [
        [viewApi, b],
        [homeApi, a],
      ] as const) {
        for (const thread of remote.threads) {
          const view = scenarioWatch(
            client.watchThread(
              { threadId: qualifyId(thread, remote.node), incremental: true },
              { signal: abort.signal },
            ),
          );

          readers.push(view.done);
          views.push(view);
        }

        readers.push(
          (async () => {
            try {
              for await (const _ of client.watchOverview({ includeSnapshot: true }, { signal: abort.signal })) {
                /* sidebar */
              }
            } catch {
              /* cancellation */
            }
          })(),
        );
      }

      for (let index = 0; index < views.length; index++) await views[index]!.until(`Scenario ${index % 3}`);
      const connection = Schema.decodeSync(Schema.fromJsonString(Connection))(await viewer.run("mobile"));
      const transport = nodePinnedTransport();
      const invitation = await viewApi.createMobilePairing({});

      const paired = await routedMobileClient({ connection, transport }).pairing.exchangeMobilePairing({
        code: invitation.code,
        name: "CPU scenario",
        platform: "android",
      });

      const phone = routedMobileClient({ connection, transport, token: paired.deviceToken });

      const phoneView = scenarioWatch(
        phone.api.watchThread(
          { threadId: qualifyId(b.threads[0]!, b.node), incremental: true },
          { signal: abort.signal },
        ),
      );

      readers.push(phoneView.done);
      await phoneView.until("Scenario 0");
      await bff.run("watch", { url: a.url, threads: [qualifyId(b.threads[0]!, b.node)] });
      await Bun.sleep(500);
      const roles = { home, viewer, bff };

      for (const child of Object.values(roles)) await child.run("begin");
      await home.run("stream");
      const changed = performance.now();
      await homeApi.updateThread({ threadId: b.threads[0]!, title: "Streaming complete" });
      await views[0]!.until("Streaming complete");
      await phoneView.until("Streaming complete");
      const consistencyMs = performance.now() - changed;

      for (const view of views) expect(view.failure).toBeUndefined();
      expect(phoneView.failure).toBeUndefined();

      for (const [role, child] of Object.entries(roles))
        console.log("CANOPY_SYNC_PROCESS", role, await child.run("end"));

      for (const child of Object.values(roles)) await child.run("begin");
      await Bun.sleep(10_200);

      for (const [role, child] of Object.entries(roles)) console.log("CANOPY_SYNC_IDLE", role, await child.run("end"));
      abort.abort();
      await Promise.all(readers);
      await bff.close();
      const restarted = decodeInfo(await home.run("restart"));
      await api(restarted.url).updateThread({ threadId: b.threads[0]!, title: "Offline change" });
      const reconnect = performance.now();
      await home.run("attach");
      await viewer.run("mirror", { node: b.node, threads: [b.threads[0]!] });
      console.log(
        "CANOPY_SYNC_CONSISTENCY",
        JSON.stringify({ consistencyMs, reconnectMs: performance.now() - reconnect }),
      );
    } finally {
      abort.abort();
      await Promise.allSettled(readers);
      await bff.close();
      await home.close();
      await viewer.close();
    }
  },
  180_000,
);
