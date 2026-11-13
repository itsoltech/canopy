import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toBinary } from "@bufbuild/protobuf";
import { SyntaxRole, ThreadFileHighlightSchema, type ui } from "@canopy/contracts";
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

describe.skipIf(!dockerAvailable)("bounded file highlighting at the thread's home", () => {
  const dir = tempDir("canopy-thread-highlight-");
  let home: Awaited<ReturnType<typeof worktreeFixture>>;
  let caller: Awaited<ReturnType<typeof startTestGateway>>;
  let a: LinkedComputers;
  let b: LinkedComputers;
  let thread: ui.Thread;
  const source = 'const count = 1;\n/* a multiline comment\ncontinued comment\n*/\nconst name = "sample";\n';
  const hash = createHash("sha256").update(source).digest("hex");

  const request = () => ({
    threadId: qualifyId(thread.id, b.hello().nodeId),
    path: "sample.ts",
    sha256: hash,
    startLine: 3,
    lineCount: 2,
  });

  beforeAll(async () => {
    const data = join(dir, "home");
    mkdirSync(data);
    home = await worktreeFixture(data, {
      role: "desktop",
      capabilities: ["thread_file_highlight_v1", "thread_files_v1", "thread_file_preview_v1"],
    });
    thread = await home.tree();
    writeFileSync(join(thread.cwd, "sample.ts"), source);
    caller = await startTestGateway({ role: "desktop" });

    const connect = (gw: typeof caller) =>
      linkedComputers({
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

  test("a remote window carries semantic offsets with preceding multiline context, without source or styles", async () => {
    const result = await caller.api.getThreadFileHighlight(request());
    expect(result.sha256).toBe(hash);
    expect(result.incomplete).toBe(false);
    expect(result.lines.map((line) => line.line)).toEqual([3, 4]);
    expect(result.lines[0]?.spans.some((span) => span.role === SyntaxRole.COMMENT)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("continued comment");
    expect(JSON.stringify(result)).not.toContain("var(--");

    for (const line of result.lines)
      for (const span of line.spans) {
        expect(span.from).toBeGreaterThanOrEqual(0);
        expect(span.to).toBeLessThanOrEqual(source.split("\n")[line.line - 1]?.length ?? 0);
      }
  }, 30_000);

  test("explicit draft preview is isolated from the saved revision and never writes the file", async () => {
    const result = await caller.api.getThreadFileHighlight({
      ...request(),
      startLine: 1,
      lineCount: 1,
      draft: "// draft preview\n",
      draftRevision: "edit-1",
    });

    expect(result.draftRevision).toBe("edit-1");
    expect(result.lines[0]?.spans.some((span) => span.role === SyntaxRole.COMMENT)).toBe(true);
    const read = await caller.api.readThreadFile({ threadId: request().threadId, path: "sample.ts" });
    expect(read.sha256).toBe(hash);
    expect(new TextDecoder().decode(read.content)).toBe(source);
    const saved = await caller.api.getThreadFileHighlight({ ...request(), startLine: 1, lineCount: 1 });
    expect(saved.draftRevision).toBe("");
    expect(saved.lines[0]?.spans.some((span) => span.role === SyntaxRole.KEYWORD)).toBe(true);
  });

  test("owner isolation and path checks apply before the CPU executor, including symlink escapes", async () => {
    const owner = await home.gw.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("highlight-owner@example.test", "Other owner")),
    );

    const foreign = Bun.randomUUIDv7();
    await home.sql(
      (sql) => sql`
      INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, depth, runtime, provider, worker_id, workspace_id, cwd, title, status)
      SELECT ${foreign}::uuid, project_id, ${owner}::uuid, 'main', ${foreign}::uuid, 0, runtime, provider, worker_id, workspace_id, cwd, 'Private file', 'idle'
      FROM threads WHERE id=${thread.id}::uuid
    `,
    );
    expect(
      await failure(
        caller.api.getThreadFileHighlight({ ...request(), threadId: qualifyId(foreign, b.hello().nodeId) }),
      ),
    ).toContain("Thread unavailable");
    const outside = join(dir, "private.ts");
    writeFileSync(outside, source);
    symlinkSync(outside, join(thread.cwd, "escape.ts"));

    for (const path of [
      "../private.ts",
      "..\\private.ts",
      outside,
      "C:/private.ts",
      ".git/config",
      "bad\0path",
      "escape.ts",
    ])
      expect(await failure(caller.api.getThreadFileHighlight({ ...request(), path }))).toBeTruthy();
  });

  test("changed hashes, oversized drafts and unbounded windows are refused", async () => {
    for (const extra of [
      { sha256: "0".repeat(64) },
      { startLine: 0 },
      { lineCount: 201 },
      { draft: "x".repeat(400 * 1024 + 1), draftRevision: "edit-2" },
      { draft: "text" },
    ])
      expect(await failure(caller.api.getThreadFileHighlight({ ...request(), ...extra }))).toBeTruthy();
    writeFileSync(join(thread.cwd, "sample.ts"), "changed on disk");
    expect(await failure(caller.api.getThreadFileHighlight(request()))).toContain("changed on disk");
    writeFileSync(join(thread.cwd, "sample.ts"), source);
  });

  test("large token output is bounded; a long line never fabricates following grammar state", async () => {
    const dense = `${'const x = "a"; '.repeat(100)}\n`.repeat(200);
    writeFileSync(join(thread.cwd, "dense.ts"), dense);

    const result = await caller.api.getThreadFileHighlight({
      ...request(),
      path: "dense.ts",
      sha256: createHash("sha256").update(dense).digest("hex"),
      startLine: 1,
      lineCount: 200,
    });

    expect(toBinary(ThreadFileHighlightSchema, result).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(result.lines.length).toBeLessThanOrEqual(200);
    const long = `${"x".repeat(100_000)}\nconst tail = 1;`;
    writeFileSync(join(thread.cwd, "long.ts"), long);

    const plain = await caller.api.getThreadFileHighlight({
      ...request(),
      path: "long.ts",
      sha256: createHash("sha256").update(long).digest("hex"),
      startLine: 2,
      lineCount: 1,
    });

    expect(plain.incomplete).toBe(true);
    expect(plain.lines).toEqual([]);
  }, 30_000);

  test("older worker capability falls back before dispatch; restart drops only ephemeral token state", async () => {
    const worker = home.gw.core.link.connections.get(home.workerId)!;
    const capabilities = worker.hello.capabilities;
    worker.hello.capabilities = capabilities.filter((value) => value !== "thread_file_highlight_v1");

    try {
      expect(await failure(caller.api.getThreadFileHighlight(request()))).toContain("Update Canopy");
    } finally {
      worker.hello.capabilities = capabilities;
    }

    await home.restart();
    const result = await caller.api.getThreadFileHighlight(request());
    expect(result.lines[0]?.spans.some((span) => span.role === SyntaxRole.COMMENT)).toBe(true);
  }, 30_000);
});
