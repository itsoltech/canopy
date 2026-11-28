import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { startWorker } from "./support/transfer-worker.ts";
import { commit, git } from "./support/worktrees.ts";

/**
 * "Move to…" between linked computers with the thread's own session and files (docs/thread-transfers.md): two
 * gateways, each with a real worker and the Codex wire fixture. The preview offers the native mode, the move takes
 * the rollout, an unpushed commit and new files into a new worktree on the other computer, and the thread there
 * continues the same Codex session in that worktree.
 */
describe.skipIf(!dockerAvailable)("moving a thread with its session to a linked computer", () => {
  const dir = tempDir("canopy-native-move-");
  const previousTrace = process.env["INSTANCE_TRACE"];
  let a: TestGateway;
  let c: TestGateway;
  let la: LinkedComputers;
  let lc: LinkedComputers;
  let wa: Awaited<ReturnType<typeof startWorker>>;
  let wc: Awaited<ReturnType<typeof startWorker>>;
  let repoA = "";
  let repoC = "";

  const runtime = (gw: TestGateway) =>
    linkedComputers({
      store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
      host: "127.0.0.1",
      heartbeatMs: 150,
      serve: remoteServe(uiHandlers(gw.core), gw.core),
      core: gw.core,
    });

  beforeAll(async () => {
    process.env["INSTANCE_TRACE"] = join(dir, "trace.jsonl");
    const origin = join(dir, "origin.git");
    const seed = join(dir, "seed");
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(dir, "clone", "-q", origin, seed);
    commit(seed, "app.txt", "one\n");
    git(seed, "push", "-qu", "origin", "main");
    repoA = join(dir, "repo-a");
    repoC = join(dir, "repo-c");
    git(dir, "clone", "-q", origin, repoA);
    git(dir, "clone", "-q", origin, repoC);

    a = await startTestGateway({ role: "desktop" });
    c = await startTestGateway({ role: "desktop" });
    wa = await startWorker(a, join(dir, "a"), "Laptop");
    wc = await startWorker(c, join(dir, "c"), "Office");
    la = runtime(a);
    lc = runtime(c);

    for (const [gw, l] of [
      [a, la],
      [c, lc],
    ] as const) {
      gw.core.computers = l;
      gw.core.network = l.options.network;
      await l.start();
    }

    await c.api.linkComputer({ address: la.addresses[0]!, code: (await a.api.createComputerPairing({})).code });
    await eventually(
      async () => la.reachable().includes(lc.hello().nodeId) && lc.reachable().includes(la.hello().nodeId),
      Boolean,
    );
  }, 180_000);

  afterAll(async () => {
    try {
      await Promise.allSettled([la?.close(), lc?.close()]);
      await wa?.close();
      await wc?.close();
      await Promise.allSettled([a?.close(), c?.close()]);
    } finally {
      if (previousTrace === undefined) delete process.env["INSTANCE_TRACE"];
      else process.env["INSTANCE_TRACE"] = previousTrace;
    }
  }, 60_000);

  interface Probe {
    event: string;
    home: string;
    session: string;
  }

  /** What the Codex fixture recorded on the given computer's worker. */
  const probes = (root: string) =>
    readFileSync(join(dir, "trace.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Probe)
      .filter((p) => p.home.startsWith(`${root}/`));

  /** Asks the fixture for the folder its session runs in, through the gateway that now has the thread. */
  async function ask(gw: TestGateway, threadId: string) {
    const turn = (
      await gw.api.sendMessage({ threadId, text: "REPORT_THREAD_CWD", clientRequestId: Bun.randomUUIDv7() })
    ).turn!;

    const rows = await eventually(
      () => gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(threadId))),
      (all) => all.some((t) => t.id === turn.id && ["completed", "failed"].includes(t.status)),
      20_000,
    );

    const { items } = await gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(threadId)));
    const answer = items.findLast((i) => i.turnId === turn.id && i.item?.content.case === "agentMessage");

    return {
      status: rows.find((t) => t.id === turn.id)!.status,
      cwd:
        answer?.item?.content.case === "agentMessage"
          ? (JSON.parse(answer.item.content.value.text) as { cwd: string }).cwd
          : "",
    };
  }

  /**
   * A Codex thread on the laptop with a rollout, an unpushed commit and a new file, moved with them to the office
   * computer's workspace.
   */
  async function moveThread(title: string) {
    const cNode = lc.hello().nodeId;
    const project = (await a.api.createProject({ name: title })).project!.id;

    const workspace = (await a.api.createWorkspace({ projectId: project, workerId: wa.workerId, rootPath: repoA }))
      .workspace!.id;

    const cProject = (await c.api.createProject({ name: title })).project!.id;

    const cWorkspace = (await c.api.createWorkspace({ projectId: cProject, workerId: wc.workerId, rootPath: repoC }))
      .workspace!.id;

    const threadId = (
      await a.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
        permissionMode: PermissionMode.FULL_AUTO,
        baseRef: "main",
      })
    ).thread!.id;

    const oldCwd = (await ask(a, threadId)).cwd;
    const source = await a.runtime.runPromise(GatewayStore.use((s) => s.thread(threadId)));
    const session = source.provider_thread_id!;

    // A rollout next to the fixture's own session record, as Codex writes it.
    const home = [wa.home, join(wa.data, "codex-home")].find((h) =>
      existsSync(join(h, "sessions", `${session}.json`)),
    )!;

    const day = join(home, "sessions", "2026", "11", "28");
    mkdirSync(day, { recursive: true });
    const rollout = `rollout-2026-11-28T10-00-00-${session}.jsonl`;
    const meta = { type: "session_meta", payload: { id: session, cwd: oldCwd, model_provider: "openai" } };
    writeFileSync(join(day, rollout), `${JSON.stringify(meta)}\n`);
    const unpushed = commit(oldCwd, "local.txt", `${title}: not pushed\n`);
    writeFileSync(join(oldCwd, "notes.md"), "new file\n");

    const preview = await a.api.previewMove({ nodeId: cNode, items: [{ kind: "thread", id: threadId }] });
    expect(preview.items[0]).toMatchObject({ blocked: "", nativeFiles: true });

    await a.api.startMove({
      nodeId: cNode,
      items: [{ kind: "thread", id: threadId }],
      placements: [{ projectId: project, workspaceId: qualifyId(cWorkspace, cNode) }],
      nativeFiles: [threadId],
    });

    const record = await eventually(
      async () => (await c.api.getMoves({})).moves.find((r) => r.itemId === threadId),
      (r) => r?.state === "done",
      60_000,
    );

    expect(record?.state).toBe("done");
    // The record here says what happened: the same session, not a new one with a handoff note.
    expect(record?.redo).toContain("The agent continues its session here in a new worktree");
    expect(record?.redo.join("\n")).not.toContain("handoff note");
    const moved = await c.runtime.runPromise(GatewayStore.use((s) => s.thread(threadId)));
    expect(moved).toMatchObject({ worker_id: wc.workerId, workspace_id: cWorkspace, provider_thread_id: session });

    return { threadId, session, rollout, unpushed, moved };
  }

  test("the session, an unpushed commit and new files continue in a new worktree on the other computer", async () => {
    const { threadId, session, rollout, unpushed, moved } = await moveThread("Native");
    expect(moved.worktree_id).toBeTruthy();
    expect(git(moved.cwd!, "rev-parse", "HEAD")).toBe(unpushed);
    expect(readFileSync(join(moved.cwd!, "notes.md"), "utf8")).toBe("new file\n");

    const adopted = [wc.home, join(wc.data, "codex-home")].some((h) =>
      existsSync(join(h, "sessions", "2026", "11", "28", rollout)),
    );

    expect(adopted).toBe(true);
    // The next turn on the other computer resumes the same session (not a new one) in the new worktree.
    const before = probes(join(dir, "c")).length;
    expect(await ask(c, threadId)).toEqual({ status: "completed", cwd: moved.cwd! });

    expect(probes(join(dir, "c")).slice(before)).toContainEqual(expect.objectContaining({ event: "turn", session }));
  }, 180_000);

  test("a session Codex can't find on the other computer is never replaced by a new one", async () => {
    const { threadId, session } = await moveThread("Missing rollout");
    const markers = [wc.home, join(wc.data, "codex-home")].map((h) => join(h, "no-rollout"));
    const before = probes(join(dir, "c")).length;

    try {
      for (const marker of markers) if (existsSync(dirname(marker))) writeFileSync(marker, "");
      // The first turn there: Codex reports no rollout, and the moved history keeps the session from being replaced.
      expect((await ask(c, threadId)).status).toBe("failed");
    } finally {
      for (const marker of markers) rmSync(marker, { force: true });
    }

    const after = await c.runtime.runPromise(GatewayStore.use((s) => s.thread(threadId)));
    expect(after.provider_thread_id).toBe(session);

    const started = probes(join(dir, "c"))
      .slice(before)
      .filter((p) => p.event === "thread/start");

    expect(started).toEqual([]);
  }, 180_000);
});
