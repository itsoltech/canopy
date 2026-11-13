import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ItemSchema, Provider, type Item } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink, resendPending, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { WorkerHost, serveLink } from "@canopy/worker/runtime";
import { THREAD_IMAGE_REPLIES_CAPABILITY } from "@canopy/domain/release/protocol";
import { ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { pruneDatabase } from "../../apps/gateway/src/maintenance/prune.ts";

const temp = tempDirs();

describe.skipIf(!dockerAvailable)("image replies through the real WorkerHost and gateway", () => {
  const dir = temp("canopy-image-messages-");
  const repo = join(dir, "repo");
  const data = join(dir, "worker");
  const executable = join(import.meta.dir, "fixtures/image-codex.ts");

  const png = Uint8Array.fromBase64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );

  let gw: TestGateway;
  let runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
  let host: WorkerHost;
  let link: GatewayLink;
  let serving: Promise<unknown>;
  let workerId = "";
  let credential = "";
  let projectId = "";
  let workspaceId = "";

  async function connect() {
    link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential,
      hello: {
        workerId,
        host: { os: process.platform },
        attachmentsRoot: host.attachmentsRoot,
        capabilities: [THREAD_IMAGE_REPLIES_CAPABILITY],
        runningTurns: host.runningTurns(),
        ...(await runtime.runPromise(journalHello())),
      },
    });
    await runtime.runPromise(
      resendPending(
        link,
        (event) => host.sendPreviews(link, event),
        (event) => host.canSendEvent(event),
      ),
    );
    serving = serveLink(link, host, runtime);
  }

  beforeAll(async () => {
    mkdirSync(repo);
    mkdirSync(data);
    writeFileSync(join(repo, "screen.png"), png);
    gw = await startTestGateway();
    const added = await gw.addWorker("Image worker");
    workerId = added.workerId;
    credential = added.credential;
    await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.setWorkerConfig(
          workerId,
          {
            codex: { enabled: true, executablePath: executable },
            claude: { enabled: false },
          },
          gw.userId,
        ),
      ),
    );
    runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
    host = new WorkerHost({
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
    await connect();
    expect(
      (
        await eventually(
          () => gw.api.getOverview({}),
          (o) => o.workers.some((w) => w.id === workerId && w.appliedVersion > 0n),
        )
      ).workers.some((w) => w.id === workerId && w.appliedVersion > 0n),
    ).toBe(true);
    projectId = (await gw.api.createProject({ name: "Image messages" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo })).workspace!.id;
  }, 60_000);

  afterAll(async () => {
    link?.close();
    await serving;
    await host?.close();
    await runtime?.dispose();
    await gw?.close();
  });

  async function reply(text: string, show = false) {
    const thread = (
      await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "Image reply" })
    ).thread!;

    expect(
      (
        await eventually(
          () => gw.api.getThread({ threadId: thread.id }),
          (r) => r.thread?.status === "idle",
        )
      ).thread?.status,
    ).toBe("idle");

    const sent = await gw.api.sendMessage({
      threadId: thread.id,
      clientRequestId: crypto.randomUUID(),
      text: JSON.stringify({ text, show }),
    });

    const turns = await eventually(
      () => gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(thread.id))),
      (rows) => rows.some((row) => row.id === sent.turn!.id && row.status === "completed"),
      15_000,
    );

    expect(turns.find((row) => row.id === sent.turn!.id)?.status).toBe("completed");
    const snapshot = await gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(thread.id)));
    const items = snapshot.items.flatMap((row) => (row.item ? [row.item] : []));
    const item = items.find((i) => i.content.case === "agentMessage");
    expect(item?.content.case).toBe("agentMessage");

    return { threadId: thread.id, turnId: sent.turn!.id, items, item: item! };
  }

  const images = (item: Item) => (item.content.case === "agentMessage" ? item.content.value.images : []);

  test("waits for its completed message when transient ingestion retries release the worker stream", async () => {
    const query = (text: string) => gw.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe(text)));
    await query("CREATE SEQUENCE image_completion_retry");
    await query(`CREATE FUNCTION delay_image_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind='item_completed' AND nextval('image_completion_retry') <= 2 THEN
        RAISE EXCEPTION 'transient image completion failure' USING ERRCODE='40001';
      END IF;
      RETURN NEW;
    END $$`);
    await query(
      "CREATE TRIGGER delay_image_completion BEFORE INSERT ON thread_events FOR EACH ROW EXECUTE FUNCTION delay_image_completion()",
    );

    try {
      const result = await reply("![After ingestion recovery](screen.png)");
      expect(images(result.item)).toHaveLength(1);
    } finally {
      await query("DROP TRIGGER delay_image_completion ON thread_events");
      await query("DROP FUNCTION delay_image_completion()");
      await query("DROP SEQUENCE image_completion_retry");
    }
  }, 30_000);

  test("imports parsed local images in position after empty completion; code and remote images stay inert", async () => {
    const text =
      "```md\n![Actual](screen%2Epng)\n```\n\n`![Actual](screen%2Epng)`\n\n![Actual](screen%2Epng)\n\n![Remote](https://example.invalid/private.png)\n";

    const result = await reply(text);
    expect(result.item.content.case === "agentMessage" && result.item.content.value.text).toBe(text);
    const saved = images(result.item);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      sourcePath: "screen%2Epng",
      alt: "Actual",
      markdownStart: text.lastIndexOf("![Actual]"),
      markdownEnd: text.lastIndexOf("![Actual]") + "![Actual](screen%2Epng)".length,
    });
    expect(result.items.filter((i) => i.content.case === "imageGallery")).toHaveLength(0);
    const first = await gw.api.getAttachment({ attachmentId: saved[0]!.attachmentId });
    unlinkSync(join(repo, "screen.png"));
    link.close();
    await serving;

    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    await gw.close(true);
    gw = await startTestGateway({ storage });
    await connect();
    expect((await gw.api.getAttachment({ attachmentId: saved[0]!.attachmentId })).data).toEqual(first.data);
    const snapshot = await gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(result.threadId)));
    expect(snapshot.items.filter((row) => row.item?.content.case === "agentMessage")).toHaveLength(1);
    writeFileSync(join(repo, "screen.png"), png);
  }, 30_000);

  test("fork history retains the same immutable image after maintenance without copying its attachment", async () => {
    const result = await reply("![Inherited image](screen.png)");
    const original = images(result.item)[0]!;
    const fork = (await gw.api.createThread({ forkThreadId: result.threadId, forkAtTurnId: result.turnId })).thread!;

    expect(
      (
        await eventually(
          () => gw.api.getThread({ threadId: fork.id }),
          (r) => r.thread?.status === "idle",
        )
      ).thread?.status,
    ).toBe("idle");
    await gw.runtime.runPromise(pruneDatabase(gw.userId));
    const snapshot = await gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(fork.id)));
    const inherited = snapshot.items.find((row) => row.item?.itemId === result.item.itemId);

    expect(inherited?.inherited).toBe(true);
    expect(images(inherited!.item!)[0]?.attachmentId).toBe(original.attachmentId);
    expect((await gw.api.getAttachment({ attachmentId: original.attachmentId })).data.length).toBeGreaterThan(0);
  }, 30_000);

  test("reconnect replays a committed import receipt before releasing the terminal journal boundary", async () => {
    const reached = Promise.withResolvers<void>();
    const handle = host.handleAgentToolResult.bind(host);
    let delayed = true;
    host.handleAgentToolResult = (result) => {
      if (delayed) {
        delayed = false;
        reached.resolve();

        return;
      }

      handle(result);
    };

    const pending = reply("![Receipt replay](screen.png)");

    try {
      await reached.promise;
      const held = host.runningTurns()[0];
      expect(held).toBeDefined();
      expect((await gw.api.getThread({ threadId: held!.threadId })).thread?.status).toBe("running");
      const journal = await runtime.runPromise(Journal.use((j) => j.pending(new Map())));
      expect(journal.some((event) => event.body.case === "turnFinished" && !host.canSendEvent(event))).toBe(true);
      link.close();
      await serving;
      await connect();
      const result = await pending;
      expect(images(result.item)).toHaveLength(1);
      expect(result.items.filter((item) => item.content.case === "agentMessage")).toHaveLength(1);
      expect(await host.flush(5_000)).toBe(true);
    } finally {
      host.handleAgentToolResult = handle;
    }
  }, 30_000);

  test("a slow copy holds only its terminal boundary and preserves other threads' text", async () => {
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const handle = host.handleCommand.bind(host);
    let gated = false;
    host.handleCommand = async (command) => {
      if (!gated && command.kind.case === "exportThreadImage" && command.kind.value.operation === "probe") {
        gated = true;
        reached.resolve();
        await gate.promise;
      }

      return handle(command);
    };

    const pending = reply("![Slow screenshot](screen.png)");

    try {
      await reached.promise;
      const held = host.runningTurns()[0];
      expect(held).toBeDefined();
      expect((await gw.api.getThread({ threadId: held!.threadId })).thread?.status).toBe("running");
      const other = await reply("Unrelated text continues.");
      expect(other.item.content.case === "agentMessage" && other.item.content.value.text).toBe(
        "Unrelated text continues.",
      );
      expect(host.runningTurns()).toContainEqual(held!);
    } finally {
      gate.resolve();
      host.handleCommand = handle;
    }

    expect(images((await pending).item)).toHaveLength(1);
  }, 30_000);

  test("refuses missing, escaping and excessive local images while keeping the agent text and turn usable", async () => {
    for (const text of [
      "![Missing](missing.png)",
      "![Private](/private/screen.png)",
      Array.from({ length: 11 }, () => "![Too many](screen.png)").join("\n"),
    ]) {
      const result = await reply(text);
      expect(images(result.item)).toHaveLength(0);
      expect(result.item.content.case === "agentMessage" && result.item.content.value.text).toBe(text);
      expect(result.item.content.case === "agentMessage" && result.item.content.value.imageError).toContain(
        "Couldn't show these images",
      );
    }

    const clean = await reply("Plain answer after a failed image.");
    expect(images(clean.item)).toHaveLength(0);
  }, 45_000);

  test("show_images succeeds through runtime export before the provider ends its turn", async () => {
    const result = await reply("Published the selected screenshot.", true);
    const galleries = result.items.filter((i) => i.content.case === "imageGallery");
    expect(galleries).toHaveLength(1);
    expect(galleries[0]?.content.case === "imageGallery" && galleries[0].content.value.images[0]?.alt).toBe(
      "Published by the worker",
    );
  }, 30_000);

  test("worker-authored manifests are quarantined and changed source text loses its saved-image binding", async () => {
    const result = await reply("![Immutable source](screen.png)");
    const original = images(result.item)[0]!;
    expect(original.attachmentId).toBeTruthy();

    const forged = await runtime.runPromise(
      Journal.use((j) =>
        j.append(result.threadId, {
          turnId: result.turnId,
          body: { case: "itemCompleted", value: { item: result.item } },
        }),
      ),
    );

    link.send({ case: "threadEvent", value: forged });
    expect(await host.flush(5_000)).toBe(true);
    const preserved = await gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(result.threadId)));
    expect(images(preserved.items.find((row) => row.item?.itemId === result.item.itemId)!.item!)[0]?.attachmentId).toBe(
      original.attachmentId,
    );

    const changedItem = create(ItemSchema, {
      itemId: result.item.itemId,
      status: result.item.status,
      content: { case: "agentMessage", value: { text: "![Immutable source](screen.png) Changed after publication." } },
    });

    const changed = await runtime.runPromise(
      Journal.use((j) =>
        j.append(result.threadId, {
          turnId: result.turnId,
          body: { case: "itemCompleted", value: { item: changedItem } },
        }),
      ),
    );

    link.send({ case: "threadEvent", value: changed });
    expect(await host.flush(5_000)).toBe(true);
    const snapshot = await gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(result.threadId)));
    expect(images(snapshot.items.find((row) => row.item?.itemId === result.item.itemId)!.item!)).toHaveLength(0);
  }, 30_000);
});
