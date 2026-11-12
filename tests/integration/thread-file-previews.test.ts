import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { FileResolution, ItemSchema, ItemStatus, type ui } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";
import { worktreeFixture } from "./support/worktrees.ts";

const LIMIT = 2 * 1024 * 1024;
const text = (file: ui.ThreadFile) => new TextDecoder().decode(file.content);

describe.skipIf(!dockerAvailable)("thread file previews through a real home worker and computer link", () => {
  const dir = tempDir("canopy-file-previews-");
  let home: Awaited<ReturnType<typeof worktreeFixture>>;
  let caller: Awaited<ReturnType<typeof startTestGateway>>;
  let a: LinkedComputers;
  let b: LinkedComputers;
  let thread: ui.Thread;
  const q = () => qualifyId(thread.id, b.hello().nodeId);

  const put = (path: string, content: string | Uint8Array) => {
    const target = join(thread.cwd, path);
    writeFileSync(target, content);

    return target;
  };

  /** Persist the same protobuf JSON the ingest projection uses, without starting a model turn. */
  async function turnItems(threadId: string, messages: string[]) {
    const turnId = Bun.randomUUIDv7();
    const ids = messages.map(() => Bun.randomUUIDv7());
    await home.sql((sql) => sql`
      INSERT INTO turns (id, thread_id, ordinal, status, trigger, input, first_seq, last_seq)
      SELECT ${turnId}::uuid, ${threadId}::uuid, COALESCE(MAX(ordinal), 0) + 1,
        'completed', 'provider', '{}'::jsonb, 100, 100
      FROM turns WHERE thread_id=${threadId}::uuid
    `);

    for (const [index, message] of messages.entries()) {
      const itemId = ids[index]!;

      const content = JSON.stringify(toJson(ItemSchema, create(ItemSchema, {
        itemId,
        status: ItemStatus.COMPLETED,
        content: { case: "agentMessage", value: { text: message } },
      })));

      await home.sql((sql) => sql`
        INSERT INTO thread_items (thread_id, item_id, turn_id, type, status, content, first_seq, last_seq)
        VALUES (${threadId}::uuid, ${itemId}, ${turnId}::uuid, 'agentMessage', 'completed', ${content}::jsonb, 100, 100)
      `);
    }

    return ids[0]!;
  }

  beforeAll(async () => {
    const data = join(dir, "home");
    mkdirSync(data);
    home = await worktreeFixture(data, {
      role: "desktop",
      capabilities: ["thread_files_v1", "thread_file_preview_v1"],
    });
    thread = await home.tree();
    mkdirSync(join(thread.cwd, "public"));
    mkdirSync(join(thread.cwd, "assets"));
    caller = await startTestGateway({ role: "desktop" });

    const connect = (gw: typeof caller) => linkedComputers({
      store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
      host: "127.0.0.1",
      heartbeatMs: 100,
      serve: remoteServe(uiHandlers(gw.core), gw.core),
    });

    a = connect(caller);
    b = connect(home.gw);
    caller.core.computers = a;
    caller.core.network = a.options.network;
    home.gw.core.computers = b;
    home.gw.core.network = b.options.network;
    await a.start();
    await b.start();
    const invitation = await caller.api.createComputerPairing({});
    await home.gw.api.linkComputer({ address: a.addresses[0]!, code: invitation.code });
    await eventually(async () => a.reachable().includes(b.hello().nodeId), Boolean);
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
    await caller?.close();
    await home?.close();
  }, 30_000);

  test("a bare name resolves inside the thread worktree, rather than its source checkout", async () => {
    writeFileSync(join(home.repo, "nested.txt"), "wrong checkout");
    const path = put("public/nested.txt", "worktree bytes");

    for (const [api, threadId] of [[home.gw.api, thread.id], [caller.api, q()]] as const) {
      const file = await api.readThreadFile({ threadId, path: "nested.txt" });
      expect(file).toMatchObject({ path, relativePath: "public/nested.txt", resolution: FileResolution.FOUND });
      expect(text(file)).toBe("worktree bytes");
      expect(file.computer).toBe(b.hello().name);
      expect(file.searchedPaths).toEqual(["nested.txt", "**/nested.txt"]);
    }
  });

  test("ambiguous names return bounded choices; an explicit choice opens exactly that file", async () => {
    put("public/choice.txt", "public");
    put("assets/choice.txt", "assets");
    const ambiguous = await caller.api.readThreadFile({ threadId: q(), path: "choice.txt" });
    expect(ambiguous.resolution).toBe(FileResolution.AMBIGUOUS);
    expect(ambiguous.matches.toSorted()).toEqual(["assets/choice.txt", "public/choice.txt"]);
    expect(ambiguous.content.length).toBe(0);
    expect(ambiguous.sha256).toBe("");
    expect(text(await caller.api.readThreadFile({ threadId: q(), path: "assets/choice.txt" }))).toBe("assets");
  });

  test("same-turn paths take priority; another turn or thread cannot supply hints", async () => {
    put("hint.txt", "root");
    put("public/hint.txt", "preferred");
    put("assets/hint.txt", "other turn");
    const source = await turnItems(thread.id, ["Open `hint.txt`", "Read public/hint.txt"]);
    await turnItems(thread.id, ["Read assets/hint.txt"]);
    const foreign = await turnItems((await home.tree()).id, ["Read assets/hint.txt"]);
    expect(text(await caller.api.readThreadFile({ threadId: q(), itemId: source, path: "hint.txt" }))).toBe("preferred");
    expect(text(await caller.api.readThreadFile({ threadId: q(), itemId: foreign, path: "hint.txt" }))).toBe("root");
  });

  test("fresh gitignore-aware lookup sees new files and distinguishes absence from disappearance", async () => {
    put(".gitignore", "ignored/\n");
    mkdirSync(join(thread.cwd, "ignored"));
    put("ignored/missing.txt", "ignored bytes");
    const missing = await caller.api.readThreadFile({ threadId: q(), path: "missing.txt" });
    expect(missing.resolution).toBe(FileResolution.NOT_FOUND);
    expect(missing.searchedPaths).toEqual(["missing.txt", "**/missing.txt"]);
    const path = put("public/missing.txt", "created after the first search");
    const opened = await caller.api.readThreadFile({ threadId: q(), path: "missing.txt" });
    expect(opened.path).toBe(path);
    expect(opened.sha256).not.toBe("");
    unlinkSync(path);
    const deleted = await caller.api.readThreadFile({ threadId: q(), path, expectedSha256: opened.sha256 });
    expect(deleted.resolution).toBe(FileResolution.DELETED);
    expect(deleted.relativePath).toBe("public/missing.txt");
    expect(deleted.searchedPaths).toEqual(["public/missing.txt"]);
    expect((await caller.api.readThreadFile({ threadId: q(), path })).resolution).toBe(FileResolution.NOT_FOUND);
  });

  test("text, images and other binary bytes cross multiple linked-computer frames unchanged", async () => {
    const source = "linked file contents\n".repeat(5000);
    put("public/remote.txt", source);
    const received = await caller.api.readThreadFile({ threadId: q(), path: "remote.txt" });
    expect(text(received)).toBe(source);
    expect(received.binary).toBe(false);
    expect(received.size).toBe(BigInt(new TextEncoder().encode(source).length));

    const image = Buffer.alloc(100_000);
    image.set(Buffer.from("89504e470d0a1a0a", "hex"));
    const binary = Buffer.alloc(80_000, 0xff);
    const pdf = Buffer.from("%PDF-1.7\nASCII PDF content");

    for (const [name, bytes, mimeType] of [["remote.png", image, "image/png"], ["remote.bin", binary, "application/octet-stream"], ["remote.pdf", pdf, "application/pdf"]] as const) {
      put(`assets/${name}`, bytes);
      const file = await caller.api.readThreadFile({ threadId: q(), path: name });
      expect(file).toMatchObject({ binary: true, truncated: false, mimeType });
      expect(file.content).toEqual(new Uint8Array(bytes));
      expect(file.sha256).toHaveLength(64);
    }
  });

  test("linked reads cap text and binary previews at 2 MiB and cannot authorize mutations", async () => {
    for (const [name, bytes, binary] of [["large.txt", Buffer.alloc(LIMIT + 100, 0x61), false], ["large.bin", Buffer.alloc(LIMIT + 100), true]] as const) {
      put(`public/${name}`, bytes);
      const file = await caller.api.readThreadFile({ threadId: q(), path: name });
      expect(file).toMatchObject({ binary, truncated: true, size: BigInt(bytes.length), sha256: "" });
      expect(file.content.length).toBe(LIMIT);
      expect(file.content).toEqual(new Uint8Array(bytes.subarray(0, LIMIT)));
    }

    const result = await home.command({
      commandId: Bun.randomUUIDv7(),
      kind: { case: "readFile", value: {
        threadId: thread.id, path: "public/large.bin", workspace: thread.cwd, roots: [thread.cwd],
        includeBinary: true, maxBytes: LIMIT * 8,
      } },
    });

    expect(result?.file?.content?.length).toBe(LIMIT);
    expect(result?.file?.truncated).toBe(true);
  });

  test("another owner's thread cannot be read locally or through a linked computer", async () => {
    const owner = await home.gw.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("file-owner@example.test", "Other owner")),
    );

    put("private.txt", "private bytes");
    await home.sql((sql) => sql`UPDATE threads SET owner_user_id=${owner}::uuid WHERE id=${thread.id}::uuid`);

    try {
      for (const [api, threadId] of [[home.gw.api, thread.id], [caller.api, q()]] as const) {
        const error = await failure(api.readThreadFile({ threadId, path: "private.txt" }));
        expect(error).toContain("Thread unavailable");
        expect(error).not.toContain("private bytes");
      }
    } finally {
      await home.sql((sql) => sql`UPDATE threads SET owner_user_id=${home.gw.userId}::uuid WHERE id=${thread.id}::uuid`);
    }
  });

  test("traversal, another checkout and symlinks outside the workspace are rejected", async () => {
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "outside bytes");
    symlinkSync(outside, join(thread.cwd, "escape.txt"));
    symlinkSync(dir, join(thread.cwd, "escape-dir"));

    for (const path of ["../outside.txt", "public/../../outside.txt", "..\\outside.txt", outside, join(home.repo, "README.md"), "escape.txt", "escape-dir/outside.txt"]) {
      const error = await failure(caller.api.readThreadFile({ threadId: q(), path }));
      expect(error).toMatch(/inside this workspace|outside.*(workspace|folders)/);
      expect(error).not.toContain("outside bytes");
    }
  });

  test("a lexical workspace alias resolves absolute paths against its real directory", async () => {
    const alias = join(dir, "workspace-alias");
    symlinkSync(thread.cwd, alias);
    put("public/alias.txt", "alias bytes");
    await home.sql((sql) => sql`UPDATE threads SET cwd=${alias} WHERE id=${thread.id}::uuid`);

    try {
      const file = await caller.api.readThreadFile({ threadId: q(), path: join(alias, "public/alias.txt") });
      expect(text(file)).toBe("alias bytes");
      expect(file.relativePath).toBe("public/alias.txt");
    } finally {
      await home.sql((sql) => sql`UPDATE threads SET cwd=${thread.cwd} WHERE id=${thread.id}::uuid`);
    }
  });

  test("edits and deletion target the resolved nested path and reject stale hashes", async () => {
    const path = put("public/edit.txt", "before");
    const opened = await caller.api.readThreadFile({ threadId: q(), path: "edit.txt" });
    writeFileSync(path, "concurrent edit");
    expect(await failure(caller.api.writeThreadFile({
      threadId: q(), path: opened.path, expectedSha256: opened.sha256, content: new TextEncoder().encode("draft"),
    }))).toContain("changed on disk");
    expect(readFileSync(path, "utf8")).toBe("concurrent edit");
    const current = await caller.api.readThreadFile({ threadId: q(), path: opened.path });

    const saved = await caller.api.writeThreadFile({
      threadId: q(), path: current.path, expectedSha256: current.sha256, content: new TextEncoder().encode("saved"),
    });

    expect(readFileSync(path, "utf8")).toBe("saved");
    await caller.api.deleteThreadFile({ threadId: q(), path: saved.path, expectedSha256: saved.sha256 });
    expect((await caller.api.readThreadFile({ threadId: q(), path: saved.path, expectedSha256: saved.sha256 })).resolution).toBe(FileResolution.DELETED);
  });

  test("worker and computer-link failures remain connection errors, never missing-file results", async () => {
    home.disconnect();
    await eventually(() => home.gw.api.getOverview({}), (overview) => !overview.workers.find((w) => w.id === home.workerId)?.online);

    try {
      expect(await failure(caller.api.readThreadFile({ threadId: q(), path: "README.md" }))).toContain("offline");
    } finally {
      await home.connect();
    }

    await b.close();
    await eventually(async () => !a.reachable().includes(b.hello().nodeId), Boolean);
    const error = await failure(caller.api.readThreadFile({ threadId: q(), path: "README.md" }));
    expect(error).toMatch(/offline|disconnected|reconnect|unreachable/i);
    expect(error).not.toMatch(/no longer|find this file|NOT_FOUND/);
  });
});
