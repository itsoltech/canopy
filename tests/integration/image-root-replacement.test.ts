import { expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Provider, type AgentToolResult } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { WorkerHost, serveLink } from "@canopy/worker/runtime";
import { THREAD_IMAGE_REPLIES_CAPABILITY } from "@canopy/domain/release/protocol";
import { ManagedRuntime } from "effect";
import { eventually, startTestGateway } from "./support/gateway.ts";

const temp = tempDirs();

test.skipIf(!dockerAvailable)(
  "WorkerHost pins the root before the harness can replace it and publish a foreign PNG",
  async () => {
    const dir = temp("canopy-image-root-");
    const repo = join(dir, "repo");
    const saved = join(dir, "original");
    const foreign = join(dir, "foreign");
    const data = join(dir, "worker");
    const executable = join(import.meta.dir, "fixtures/image-root-codex.ts");
    mkdirSync(repo);
    mkdirSync(foreign);
    mkdirSync(data);
    writeFileSync(
      join(foreign, "private.png"),
      Uint8Array.fromBase64(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      ),
    );
    const gw = await startTestGateway();
    const added = await gw.addWorker("Pinned image root");
    const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));

    await gw.runtime.runPromise(
      GatewayStore.use((store) =>
        store.setWorkerConfig(
          added.workerId,
          {
            codex: { enabled: true, executablePath: executable },
            claude: { enabled: false },
          },
          gw.userId,
        ),
      ),
    );

    const host = new WorkerHost({
      runtime,
      dataDir: data,
      clientVersion: "test",
      probe: {
        which: () => executable,
        version: () => "codex-cli 0.170.0",
        realDirectory: (path) => path,
        login: () => "Fixture",
      },
    });

    const link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: added.credential,
      hello: {
        workerId: added.workerId,
        host: { os: process.platform },
        attachmentsRoot: host.attachmentsRoot,
        capabilities: [THREAD_IMAGE_REPLIES_CAPABILITY],
        ...(await runtime.runPromise(journalHello())),
      },
    });

    const serving = serveLink(link, host, runtime);
    const handle = host.handleCommand.bind(host);
    const results: AgentToolResult[] = [];
    const result = host.handleAgentToolResult.bind(host);
    let replaced = false;

    host.handleCommand = async (command) => {
      if (!replaced && command.kind.case === "exportThreadImage" && command.kind.value.operation === "probe") {
        renameSync(repo, saved);
        symlinkSync(foreign, repo, process.platform === "win32" ? "junction" : "dir");
        replaced = true;
      }

      return handle(command);
    };

    host.handleAgentToolResult = (reply) => {
      results.push(reply);
      result(reply);
    };

    try {
      await eventually(
        () => gw.api.getOverview({}),
        (o) => o.workers.some((w) => w.id === added.workerId && w.appliedVersion > 0n),
      );
      const projectId = (await gw.api.createProject({ name: "Pinned root" })).project!.id;

      const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: added.workerId, rootPath: repo }))
        .workspace!.id;

      const thread = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!;
      await eventually(
        () => gw.api.getThread({ threadId: thread.id }),
        (r) => r.thread?.status === "idle",
      );

      const sent = await gw.api.sendMessage({
        threadId: thread.id,
        clientRequestId: crypto.randomUUID(),
        text: JSON.stringify({ images: [{ path: "private.png", alt: "Foreign image" }] }),
      });

      await eventually(
        () => gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(thread.id))),
        (rows) => rows.some((row) => row.id === sent.turn!.id && row.status === "completed"),
        15_000,
      );
      expect(replaced).toBe(true);
      expect(results).toHaveLength(1);
      expect(results[0]?.isError).toBe(true);
      expect(results[0]?.content).toContain("directory changed");
      expect(results[0]?.content).not.toContain('"delivered":true');
      const snapshot = await gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(thread.id)));
      expect(snapshot.items.filter((row) => row.item?.content.case === "imageGallery")).toHaveLength(0);
    } finally {
      if (replaced) {
        rmSync(repo);
        renameSync(saved, repo);
      }

      link.close();
      await serving;
      await host.close();
      await runtime.dispose();
      await gw.close();
    }
  },
  30_000,
);
