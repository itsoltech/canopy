import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Provider, ThreadDirectoryError, ThreadLifecycleSchema, ThreadSecretDeliverySchema } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { Journal } from "@canopy/worker/journal";
import { WorkerHost, serveLink } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { connectWorker, startGateway } from "./helpers.ts";
import { eventually } from "./support/gateway.ts";

test.skipIf(process.platform === "win32")(
  "thread cleanup closes shell processes, file cursors and secrets without stopping another thread",
  async () => {
    const dir = tempDir("canopy-thread-resources-");
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);

    for (const name of ["a", "b", "c"]) writeFileSync(join(workspace, name), name);
    const gateway = await startGateway();
    const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "test" });
    const link = await connectWorker(gateway.server.url, { hello: { workerId: "worker-1" } });
    const serving = serveLink(link, host, runtime);
    const connection = await gateway.nextConnection();
    const threadId = Bun.randomUUIDv7();
    const healthyId = Bun.randomUUIDv7();
    const ownerId = Bun.randomUUIDv7();
    const starts: Promise<unknown>[] = [];

    try {
      connection.send({
        case: "config",
        value: { version: 1n, claude: { enabled: false }, codex: { enabled: false } },
      });
      await eventually(async () => Boolean(host.config), Boolean);

      const delivery = create(ThreadSecretDeliverySchema, {
        requestId: Bun.randomUUIDv7(),
        threadId,
        revision: 1,
        cwd: workspace,
        value: "fixture-private-value",
        expiresAt: timestampFromDate(new Date(Date.now() + 60_000)),
      });

      const secret = host.secrets.apply(delivery);
      expect(secret.applied).toBe(true);

      const page = await connection.sendCommand({
        case: "listThreadDirectory",
        value: { ownerId, threadId, workspace, pageSize: 1 },
      });

      const token = page.threadDirectory?.nextPageToken;
      expect(token).toBeTruthy();

      for (const id of [threadId, healthyId])
        starts.push(
          connection
            .sendCommand(
              {
                case: "startTurn",
                value: {
                  thread: { threadId: id, cwd: workspace, provider: Provider.CODEX },
                  turnId: Bun.randomUUIDv7(),
                  input: {
                    authorUserId: ownerId,
                    shellInputId: Bun.randomUUIDv7(),
                    shellCommand: "while :; do sleep 1; done",
                  },
                },
              },
              20_000,
            )
            .catch(() => undefined),
        );
      await eventually(
        () => runtime.runPromise(Journal.use((j) => j.openShellInputs())),
        (runs) => runs.length === 2 && runs.every((run) => run.pid > 0),
      );
      host.applyThreadLifecycle(create(ThreadLifecycleSchema, { closedThreadIds: [threadId] }));
      const unloaded = await connection.sendCommand({ case: "unloadThread", value: { threadId } }, 20_000);
      expect(unloaded.ok).toBe(true);
      expect(existsSync(secret.file)).toBe(false);
      expect(host.secrets.apply(delivery).applied).toBe(false);
      const remaining = await runtime.runPromise(Journal.use((j) => j.openShellInputs()));
      expect(remaining.map((run) => run.threadId)).toEqual([healthyId]);
      expect(host.runningTurns().map((turn) => turn.threadId)).toEqual([healthyId]);

      host.applyThreadLifecycle(create(ThreadLifecycleSchema, { openedThreadIds: [threadId] }));

      const fresh = await connection.sendCommand({
        case: "listThreadDirectory",
        value: { ownerId, threadId, workspace, pageSize: 1, ...(token && { pageToken: token }) },
      });

      expect(fresh.threadDirectory?.error).toBe(ThreadDirectoryError.CURSOR_EXPIRED);
      expect((await runtime.runPromise(Journal.use((j) => j.openShellInputs()))).map((run) => run.threadId)).toEqual([
        healthyId,
      ]);
      expect(existsSync(secret.file)).toBe(false);
    } finally {
      await host.close();
      await gateway.link.shutdown();
      await serving;
      await Promise.allSettled(starts);
      await gateway.server.close();
      await runtime.dispose();
    }
  },
  30_000,
);
