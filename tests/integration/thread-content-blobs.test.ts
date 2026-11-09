import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, Provider, type Item } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { AttachmentStore } from "@canopy/gateway/store";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

describe.skipIf(!dockerAvailable)("thread content blobs through their home", () => {
  let home: TestGateway;
  let client: TestGateway;
  let homeLink: LinkedComputers;
  let clientLink: LinkedComputers;
  let threadId = "";
  let turnId = "";

  const connect = async (gateway: TestGateway) => {
    const computers = linkedComputers({
      store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
      host: "127.0.0.1",
      serve: remoteServe(uiHandlers(gateway.core), gateway.core),
      core: gateway.core,
    });

    gateway.core.computers = computers;
    gateway.core.network = computers.options.network;
    await computers.start();

    return computers;
  };

  beforeAll(async () => {
    home = await startTestGateway({ role: "desktop" });
    client = await startTestGateway({ role: "desktop" });
    homeLink = await connect(home);
    clientLink = await connect(client);
    const pairing = await home.api.createComputerPairing({});
    await client.api.linkComputer({ address: homeLink.addresses[0]!, code: pairing.code });
    await eventually(async () => clientLink.reachable().includes(homeLink.hello().nodeId), Boolean, 15000);
    const project = (await home.api.createProject({ name: "Content" })).project!;
    const workerId = (await home.api.getOverview({})).workers[0]!.id;

    const workspace = (
      await home.api.createWorkspace({ projectId: project.id, workerId, rootPath: "/repo/app", label: "Content" })
    ).workspace!;

    const thread = (
      await home.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
    ).thread!;

    threadId = thread.id;
    await eventually(
      () => home.api.getThread({ threadId }),
      (value) => value.thread?.status === "idle",
    );
    turnId = (await home.api.sendMessage({ threadId, text: "Read content", clientRequestId: "content" })).turn!.id;
  }, 60000);

  afterAll(async () => {
    await clientLink?.close();
    await homeLink?.close();
    await client?.close();
    await home?.close();
  });

  async function publish(id: string, content: Item["content"], data: Uint8Array, mimeType: string) {
    const sha256 = digest(data);
    home.worker.uploadPreview(sha256, data, mimeType);
    home.worker.emit(threadId, turnId, {
      case: "itemCompleted",
      value: { item: create(ItemSchema, { itemId: id, status: ItemStatus.COMPLETED, content }) },
    });

    const read = await eventually(
      () => home.api.getThreadBlob({ threadId, sha256 }).catch(() => undefined),
      (value) => !!value,
    );

    expect(read?.data).toEqual(data);

    return sha256;
  }

  test("command, tool, background output and diffs are readable locally and at the linked home", async () => {
    for (const kind of ["commandExecution", "toolCall", "backgroundTask", "fileChange"] as const) {
      const data = encode(
        kind === "fileChange" ? "--- a/file\n+++ b/file\n-old\n+new\n" : `${kind}\n${"output\n".repeat(3000)}`,
      );

      const blob = {
        sha256: digest(data),
        sizeBytes: BigInt(data.length),
        mimeType: kind === "fileChange" ? "text/x-diff" : "text/plain",
      };

      const content =
        kind === "fileChange"
          ? create(ItemSchema, { content: { case: kind, value: { changes: [{ path: "file", diffBlob: blob }] } } })
              .content
          : create(ItemSchema, { content: { case: kind, value: { outputBlob: blob } } }).content;

      const sha256 = await publish(kind, content, data, blob.mimeType);
      const remoteId = qualifyId(threadId, homeLink.hello().nodeId);
      expect((await client.api.getThreadBlob({ threadId: remoteId, sha256 })).data).toEqual(data);
      expect(await failure(client.api.getThreadBlob({ threadId, sha256 }))).toContain("not found");
    }
  });

  test("unreferenced blobs stay private and oversized content is rejected before its bytes are returned", async () => {
    const data = encode("private content");
    const sha256 = digest(data);
    await home.runtime.runPromise(AttachmentStore.use((store) => store.putBlob(sha256, data, "text/plain")));
    expect(await failure(home.api.getThreadBlob({ threadId, sha256 }))).toContain("not found");
    const store = homeLink.store;
    await store.query("INSERT INTO thread_blobs(thread_id,sha256) VALUES($1::uuid,$2)", [threadId, sha256]);
    await store.query("UPDATE blobs SET size_bytes=$1 WHERE sha256=$2", [8 * 1024 ** 2 + 1, sha256]);
    expect(await failure(home.api.getThreadBlob({ threadId, sha256 }))).toContain("viewing limit");
    const foreign = crypto.randomUUID();
    await store.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other','user')", [
      foreign,
      `${foreign}@example.test`,
    ]);
    expect(
      await failure(home.runtime.runPromise(AttachmentStore.use((s) => s.threadBlob(foreign, threadId, sha256)))),
    ).toContain("not found");
  });
});
