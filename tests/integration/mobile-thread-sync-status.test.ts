import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { ConnectionRecovery, UNAVAILABLE_AFTER_MS } from "@canopy/domain/connection-recovery";
import { ThreadWatchRecovery } from "@canopy/domain/thread-watch-recovery";
import { threadWatchReady } from "@canopy/domain/thread-watch-state";
import { startConnectHttpServer } from "@canopy/transport";
import { mobileClient } from "../../apps/mobile/src/api/client.ts";
import { runStream } from "../../apps/mobile/src/state/stream-loop.ts";

test("a mobile thread stays syncing across the outage deadline and retries a real drop", async () => {
  let opens = 0;
  const controls = create(ui.ThreadUpdateSchema, { change: { case: "controls", value: {} } });

  const batch = (caughtUp: boolean) =>
    create(ui.ThreadUpdateSchema, { change: { case: "batch", value: { caughtUp } } });

  const server = await startConnectHttpServer({
    routes: (router) =>
      router.service(ui.GatewayService, {
        async *watchThread() {
          opens++;
          yield controls;
          yield batch(false);

          if (opens === 1) throw new ConnectError("Disconnected", Code.Unavailable);
          yield batch(true);
          yield controls;
          throw new ConnectError("Access denied", Code.PermissionDenied);
        },
      }),
  });

  try {
    const api = mobileClient({ gatewayUrl: server.url, development: true, fetch }).api;
    const recovery = new ConnectionRecovery(10_000);
    const thread = new ThreadWatchRecovery();
    const states: string[] = [];
    const failures: Code[] = [];
    await runStream({
      thread: true,
      signal: AbortSignal.timeout(5000),
      recovery,
      start: (signal) => api.watchThread({ threadId: "saved", sequence: true }, { signal }),
      receive: threadWatchReady,
      publish(phase) {
        if (phase === "connecting" || phase === "syncing") {
          // Check at the old watchdog deadline without delaying the test for every batch.
          expect(recovery.unavailableAt).toBeUndefined();
          expect(recovery.check(Date.now() + UNAVAILABLE_AFTER_MS).status).not.toBe("unavailable");
        }

        states.push(phase ?? recovery.snapshot.status);
      },
      failed(error) {
        failures.push(error.code);

        return thread.failed({ code: error.code }).action !== "stop";
      },
      started() {},
      retryAt: () => 0,
      planned: () => false,
    });
    expect(failures).toEqual([Code.Unavailable, Code.PermissionDenied]);
    expect(states).toEqual([
      "connecting",
      "syncing",
      "syncing",
      "reconnecting",
      "reconnecting",
      "syncing",
      "syncing",
      "live",
    ]);
    expect(opens).toBe(2);
  } finally {
    await server.close();
  }
});
