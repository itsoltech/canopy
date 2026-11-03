/** Real gateway, PostgreSQL, gRPC worker and Codex adapter; a local CLI stand-in records its actual cwd. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { journalHello, openGatewayLink, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("worker without directory roots", () => {
  const dir = tempDir("canopy-any-directory-");
  const dataDir = join(dir, "worker-data");
  const projectDir = join(dir, "anywhere", "project");
  const codexHome = join(dir, "device-codex");
  const executable = join(dir, "codex");
  let gw: TestGateway;
  let runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
  let host: WorkerHost;
  let link: GatewayLink;
  let workerId: string;
  let project: ui.Project;

  beforeAll(async () => {
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(dataDir);
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture" } }));
    copyFileSync(new URL("./fixtures/directory-codex.ts", import.meta.url), executable);
    chmodSync(executable, 0o755);
    gw = await startTestGateway();
    const worker = await gw.addWorker("real-directory-worker");
    workerId = worker.workerId;
    await gw.runtime.runPromise(GatewayStore.use((s) => s.setWorkerConfig(workerId, {
      // Old databases may still contain these values; none may affect startup or placement.
      allowedRoots: ["relative-and-missing", "/no-such-root"],
      codex: { enabled: true, executablePath: executable }, claude: { enabled: false },
    }, gw.userId)));
    runtime = ManagedRuntime.make(Journal.layer(join(dataDir, "journal.db")));
    host = new WorkerHost({ runtime, dataDir, clientVersion: "test", deviceHomes: { codex: codexHome, claude: join(dir, "device-claude") } });
    link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential: worker.credential, hello: {
      workerId, host: { os: process.platform }, scratchRoot: join(dataDir, "scratch"), homeDirectory: homedir(),
      ...(await runtime.runPromise(journalHello())),
    } });
    void serveLink(link, host, runtime);
    await eventually(() => gw.api.getOverview({}), (o) => o.workers.some((w) => w.id === workerId && w.appliedVersion > 0n));
    project = (await gw.api.createProject({ name: "Anywhere" })).project!;
  }, 60_000);

  afterAll(async () => {
    link?.close();
    await host?.close();
    await runtime?.dispose();
    await gw?.close();
  });

  test("any existing absolute workspace reaches the harness; absent paths and files give clear errors", async () => {
    const listing = await gw.api.listDirectory({ workerId });
    expect(listing.path).toBe(homedir());
    expect((await gw.api.getOverview({})).workers.find((w) => w.id === workerId)?.configIssues).toEqual([]);
    const workspace = (await gw.api.createWorkspace({ projectId: project.id, workerId, rootPath: projectDir })).workspace!;
    const thread = (await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })).thread!;
    await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle");
    expect(readFileSync(join(projectDir, "worker-started.txt"), "utf8")).toBe(projectDir);
    expect(await failure(gw.api.createWorkspace({ projectId: project.id, workerId, rootPath: join(dir, "missing") }))).toContain("does not exist");
    expect(await failure(gw.api.createWorkspace({ projectId: project.id, workerId, rootPath: executable }))).toContain("not a directory");
    const gone = join(dir, "gone");
    mkdirSync(gone);
    const removed = (await gw.api.createWorkspace({ projectId: project.id, workerId, rootPath: gone })).workspace!;
    rmSync(gone, { recursive: true });
    const failed = (await gw.api.createThread({ projectId: project.id, workspaceId: removed.id, provider: Provider.CODEX })).thread!;
    const result = await eventually(() => gw.api.getThread({ threadId: failed.id }), (r) => r.thread?.status === "failed");
    expect(result.thread?.statusDetail).toContain("CWD_NOT_FOUND");
    expect(existsSync(gone)).toBe(false);
  });

  test("scratch starts under worker data without roots; a thread under a previous data dir also starts", async () => {
    const scratch = (await gw.api.getOverview({})).projects.find((p) => p.kind === "scratch")!;
    const workspace = scratch.workspaces.find((w) => w.workerId === workerId)!;
    const thread = (await gw.api.createThread({ projectId: scratch.id, workspaceId: workspace.id, provider: Provider.CODEX })).thread!;
    await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle");
    expect(thread.cwd).toBe(join(dataDir, "scratch", gw.userId, thread.id));
    expect(readFileSync(join(thread.cwd, "worker-started.txt"), "utf8")).toBe(thread.cwd);
    const cwd = join(dir, "old-data", "scratch", gw.userId, Bun.randomUUIDv7());
    mkdirSync(cwd, { recursive: true });
    const connection = gw.core.link.connections.get(workerId)!;
    expect(await connection.sendCommand({ case: "createThread", value: { thread: { threadId: Bun.randomUUIDv7(), cwd, scratch: true, provider: Provider.CODEX } } })).toMatchObject({ ok: true });
    expect(readFileSync(join(cwd, "worker-started.txt"), "utf8")).toBe(cwd);
  });
});
