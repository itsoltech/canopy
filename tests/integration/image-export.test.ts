import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, isMessage } from "@bufbuild/protobuf";
import {
  ExportThreadImageSchema,
  InteractionResponseSchema,
  Provider,
  ThreadSpecSchema,
  UserInputSchema,
  type AgentToolCall,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDirs } from "@canopy/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ThreadImageExports } from "../../apps/worker/src/images/exports.ts";
import { Journal } from "../../apps/worker/src/journal/index.ts";
import { claudeBusServer } from "../../apps/worker/src/providers/claude/bus.ts";
import { CodexThreads } from "../../apps/worker/src/providers/codex/threads.ts";
import { grokBus } from "../../apps/worker/src/providers/grok/bus.ts";
import { resolveProfiles } from "../../apps/worker/src/providers/profiles.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const temp = tempDirs();

describe.skipIf(!dockerAvailable)("scoped image exports and provider tools over WorkerLink", () => {
  const base = temp("canopy-image-export-");
  const parent = join(base, "workspace");
  const root = join(parent, "repo");
  const attachments = temp("canopy-image-attachments-");
  const outside = temp("canopy-image-outside-");
  const exports = new ThreadImageExports();

  const png = Uint8Array.fromBase64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  );

  let gw: TestGateway;
  let workspaceId: string;
  let projectId: string;
  let source: Pick<AgentToolCall, "threadId" | "turnId">;

  beforeAll(async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "screen.png"), png);
    writeFileSync(join(outside, "private.png"), png);
    gw = await startTestGateway({
      worker: { hello: { capabilities: ["thread_image_replies_v1"], attachmentsRoot: attachments } },
    });
    projectId = (await gw.api.createProject({ name: "Image tools" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: root })).workspace!.id;
    gw.worker.holdTurns = true;
    const thread = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!;
    await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "idle",
    );

    const turn = (
      await gw.api.sendMessage({ threadId: thread.id, text: "Show screenshots", clientRequestId: crypto.randomUUID() })
    ).turn!;

    source = { threadId: thread.id, turnId: turn.id };
    await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "running",
    );
    mkdirSync(join(attachments, thread.id));
    mkdirSync(join(outside, thread.id));
    mkdirSync(join(outside, "repo"));
    writeFileSync(join(outside, thread.id, "private.png"), png);
    writeFileSync(join(outside, "repo", "private.png"), png);
    exports.assign(source.threadId, root, join(attachments, thread.id));
    gw.worker.handlers.set("exportThreadImage", async (value, reply) => {
      if (!isMessage(value, ExportThreadImageSchema)) return reply(false);

      try {
        reply(true, {
          threadImageExport: await exports.execute(value, {
            cwd: root,
            attachments: join(attachments, source.threadId),
            running: value.threadId === source.threadId && value.turnId === source.turnId,
          }),
        });
      } catch (error) {
        reply(false, { errorMessage: error instanceof Error ? error.message : "Image refused. Choose another file." });
      }
    });
  }, 60_000);

  afterAll(async () => {
    exports.close();
    await gw?.close();
  });

  const show = (path: string) =>
    gw.worker.callTool({ ...source, tool: "show_images", args: { images: [{ path, alt: "Effect preview" }] } });

  test("never trusts a replaced cwd, attachment root or ancestor after scope assignment", async () => {
    const directory = join(attachments, source.threadId);

    for (const { target, path } of [
      { target: root, path: "private.png" },
      { target: parent, path: "private.png" },
      { target: directory, path: join(directory, "private.png") },
      { target: attachments, path: join(directory, "private.png") },
    ]) {
      const saved = `${target}-original`;
      renameSync(target, saved);

      try {
        symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
        const reply = await show(path);
        expect(reply.isError).toBe(true);
        expect(reply.content).toContain("directory changed");
        expect(reply.content).not.toContain('"delivered":true');
        expect(() => exports.assign(source.threadId, root, directory)).toThrow("directory changed");
      } finally {
        rmSync(target);
        renameSync(saved, target);
      }
    }

    // A different real directory, without any symlink, must also fail the pinned identity check.
    renameSync(root, `${root}-original`);

    try {
      mkdirSync(root);
      writeFileSync(join(root, "private.png"), png);
      expect((await show("private.png")).isError).toBe(true);
    } finally {
      rmSync(root, { recursive: true });
      renameSync(`${root}-original`, root);
    }

    expect((await show("screen.png")).isError).toBe(false);
  });

  test("rejects traversal, foreign roots, URLs, links, directories, devices and oversized files before publication", async () => {
    symlinkSync(join(outside, "private.png"), join(root, "escape.png"));
    symlinkSync(outside, join(root, "junction"), process.platform === "win32" ? "junction" : "dir");
    linkSync(join(outside, "private.png"), join(root, "hardlink.png"));
    writeFileSync(join(root, "large.png"), Buffer.alloc(20 * 1024 ** 2 + 1));

    for (const path of [
      "../private.png",
      "sub/../screen.png",
      join(outside, "private.png"),
      "https://example.invalid/a.png",
      "file:///private.png",
      "escape.png",
      "junction/private.png",
      "hardlink.png",
      ".",
      "large.png",
    ])
      expect((await show(path)).isError).toBe(true);

    if (process.platform !== "win32") {
      const fifo = join(root, "fifo.png");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      expect((await show(fifo)).isError).toBe(true);
      symlinkSync("/dev/zero", join(root, "device.png"));
      expect((await show("device.png")).isError).toBe(true);
    }

    expect((await show("screen.png")).isError).toBe(false);
  });

  test("binds immutable bytes to an export; replacement, cross-turn reads and journal replay cannot change them", async () => {
    const directory = join(root, "original");
    mkdirSync(directory);
    writeFileSync(join(directory, "screen.png"), png);

    const request = create(ExportThreadImageSchema, {
      ...source,
      exportId: crypto.randomUUID(),
      roots: [root],
      path: "original/screen.png",
      operation: "probe",
      maxBytes: 1024n,
    });

    const scope = { cwd: root, attachments: join(attachments, source.threadId), running: true };
    expect((await exports.execute(request, scope)).data).toBeUndefined();
    renameSync(directory, join(root, "moved"));
    symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
    const read = await exports.execute({ ...request, operation: "read" }, scope);
    expect(read.data).toEqual(png);
    expect(read.sha256).toBe(createHash("sha256").update(png).digest("hex"));
    await expect(
      exports.execute({ ...request, turnId: crypto.randomUUID(), operation: "read" }, scope),
    ).rejects.toThrow("another request");
    await expect(exports.execute({ ...request, operation: "read" }, { ...scope, running: false })).rejects.toThrow(
      "ended",
    );
    exports.close();
    await expect(exports.execute({ ...request, operation: "read" }, scope)).rejects.toThrow("being prepared");
    rmSync(directory);
  });

  const forward = (calls: AgentToolCall[]) => async (call: AgentToolCall) => {
    calls.push(call);

    return gw.worker.callTool({
      ...source,
      callId: call.callId,
      tool: call.toolName,
      args: JSON.parse(call.argumentsJson),
    });
  };

  const args = { images: [{ path: "screen.png", alt: "Power-up effect" }] };

  test("Claude SDK MCP publishes a gallery with stable source IDs and returns only the receipt", async () => {
    const calls: AgentToolCall[] = [];

    const server = claudeBusServer({
      ...source,
      depth: 0,
      agentBus: true,
      turnId: () => source.turnId,
      toolUseId: () => "image-call",
      callTool: forward(calls),
    });

    const client = new Client({ name: "image-fixture", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

    try {
      await server.instance.connect(serverSide);
      await client.connect(clientSide);
      const result = await client.callTool({ name: "show_images", arguments: args });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain("delivered");
      expect(JSON.stringify(result)).not.toContain("base64");
      expect(calls[0]).toMatchObject({ ...source, toolName: "show_images", itemId: "image-call" });
    } finally {
      await client.close();
      await server.instance.close();
    }
  });

  test("Grok ACP MCP publishes a gallery and forwards validation failures without claiming delivery", async () => {
    const calls: AgentToolCall[] = [];
    const bus = grokBus({ threadId: source.threadId, depth: 1, turnId: () => source.turnId, callTool: forward(calls) });

    if (!("url" in bus.server)) throw new Error("Expected HTTP MCP.");
    const endpoint = bus.server.url;

    try {
      const headers = Object.fromEntries(bus.server.headers.map((h) => [h.name, h.value]));

      const invoke = async (images: typeof args.images) =>
        (
          await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: crypto.randomUUID(),
              method: "tools/call",
              params: { name: "show_images", arguments: { images } },
            }),
          })
        ).json() as Promise<{ result: { isError?: boolean; content: { text: string }[] } }>;

      expect((await invoke(args.images)).result.isError).not.toBe(true);
      const failed = await invoke([{ path: "../private.png", alt: "Outside" }]);
      expect(failed.result.isError).toBe(true);
      expect(JSON.stringify(failed)).not.toContain('"delivered":true');
    } finally {
      bus.close();
    }
  });

  test("Codex app-server dispatches show_images with stable platform turn and call IDs", async () => {
    const calls: AgentToolCall[] = [];
    const profile = resolveProfiles([{ kind: "native", id: "native", providers: ["codex"] }])[0]!.resolved!;

    const runtime = ManagedRuntime.make(
      CodexThreads.layer({
        launch: {
          command: [process.execPath, join(import.meta.dir, "support/bus-app-server.ts"), "show_images"],
          env: { PATH: process.env["PATH"] },
        },
        clientVersion: "test",
        profile: () => profile,
        publish: () => {},
        interact: async () => create(InteractionResponseSchema, { allow: false }),
        callTool: forward(calls),
      }).pipe(Layer.provide(Journal.layer(join(root, "codex-journal.db")))),
    );

    try {
      await runtime.runPromise(
        CodexThreads.use((threads) =>
          Effect.gen(function* () {
            const spec = create(ThreadSpecSchema, {
              threadId: source.threadId,
              provider: Provider.CODEX,
              providerProfileId: "native",
              cwd: root,
              enableAgentBus: true,
            });

            yield* threads.create(spec);
            yield* threads.startTurn(spec, source.turnId, create(UserInputSchema, { text: JSON.stringify(args) }));

            while (threads.hasActiveTurns()) yield* Effect.sleep("5 millis");
          }).pipe(Effect.timeout("10 seconds")),
        ),
      );
      expect(calls[0]).toMatchObject({ ...source, toolName: "show_images", argumentsJson: JSON.stringify(args) });
      expect(calls).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  }, 15_000);
});
