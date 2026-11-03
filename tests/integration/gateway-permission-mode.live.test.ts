/**
 * Live, through the whole stack: UI API -> gateway on PostgreSQL -> a real worker host with Codex and Claude
 * through CLIProxyAPI. The permission mode changes per turn of one thread: a READ_ONLY turn cannot write, the
 * next message in FULL_AUTO writes without asking, a turn back on the thread's READ_ONLY default cannot (Codex
 * keeps turn/start overrides, so the mode must be explicit every turn), and after UpdateThread to ASK a write
 * asks for approval. Claude also switches the mode of a process kept alive by a background task.
 * Opt-in: OA_LIVE=1 with the CLIProxyAPI env (docs/codex-adapter.md#testy-na-żywo).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InteractionKind, PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";
import { useLiveProxy } from "./support/live.ts";

const tempDir = tempDirs();

const LIVE = process.env["OA_LIVE"] === "1";
const proxyUrl = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["OA_LIVE_CLIPROXYAPI_KEY"];

const CASES = [
  { name: "codex", provider: Provider.CODEX, model: process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol" },
  { name: "claude", provider: Provider.CLAUDE, model: process.env["OA_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5" },
] as const;

const FINISHED = new Set(["completed", "failed", "interrupted", "cancelled"]);

const write = (file: string) =>
  `Create the file ${file} in the current directory containing the word hello. Use exactly one shell command: \`echo hello > ${file}\`. ` +
  "If it is blocked or refused, do not try anything else (no other tools, no workarounds) and reply BLOCKED; otherwise reply DONE.";

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)("UI API: permission mode per turn with a real worker (live)", () => {
  let gw: TestGateway;
  let workerId = "";
  let workspaceId = "";
  let projectId = "";
  let repo = "";
  let stop = async () => {};

  beforeAll(async () => {
    gw = await startTestGateway();
    repo = tempDir("oa-live-perm-repo-");
    const data = tempDir("oa-live-perm-worker-");
    const added = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: "live", ownerUserId: gw.userId })));
    workerId = added.workerId;
    await useLiveProxy(gw, workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo] });
    const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(data, "data"), clientVersion: "live" });
    const link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential: added.credential, hello: { workerId, ...(await runtime.runPromise(journalHello())) } });
    const serving = serveLink(link, host, runtime);
    stop = async () => {
      link.close();
      await serving;
      await host.close();
      await runtime.dispose();
    };
    projectId = (await gw.api.createProject({ name: "Live permissions" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo, label: "live" })).workspace!.id;
  }, 120_000);

  afterAll(async () => {
    await stop();
    await gw?.close();
  });

  /**
   * Sends a message and waits for its turn to end. Permission prompts of the turn are answered with `allow`
   * and returned; a question is answered so nothing hangs.
   */
  async function turn(threadId: string, request: { text: string; permissionMode?: PermissionMode }, allow = true) {
    const sent = await gw.api.sendMessage({ threadId, clientRequestId: Bun.randomUUIDv7(), ...request });
    const turnId = sent.turn!.id;
    const prompts: ui.Interaction[] = [];
    const answered = new Set<string>();
    const answer = (interaction: ui.Interaction) => {
      if (interaction.turnId !== turnId || interaction.status !== "pending" || answered.has(interaction.requestId)) return;
      answered.add(interaction.requestId);
      prompts.push(interaction);
      void gw.api.answerInteraction({ requestId: interaction.requestId, allow, ...(interaction.kind === InteractionKind.QUESTION && { answerJson: "{}" }) });
    };
    const updates = await watchUntil(
      gw.api,
      threadId,
      (u) =>
        u.some(
          (x) =>
            (x.change.case === "turn" && x.change.value.id === turnId && FINISHED.has(x.change.value.status)) ||
            (x.change.case === "snapshot" && x.change.value.turns.some((t) => t.id === turnId && FINISHED.has(t.status))),
        ),
      (update) => {
        if (update.change.case === "snapshot") update.change.value.interactions.forEach(answer);
        if (update.change.case === "interaction") answer(update.change.value);
      },
      300_000,
    );
    const ended =
      updates.flatMap((u) => (u.change.case === "turn" && u.change.value.id === turnId ? [u.change.value] : [])).at(-1) ??
      updates.flatMap((u) => (u.change.case === "snapshot" ? u.change.value.turns.filter((t) => t.id === turnId) : [])).at(-1)!;
    return { turn: ended, prompts };
  }

  for (const c of CASES) {
    test(`${c.name}: READ_ONLY refuses, FULL_AUTO writes without asking, back to the default, ASK asks`, async () => {
      const file = (step: string) => `${c.name}-${step}.txt`;
      const thread = (
        await gw.api.createThread({
          projectId,
          workspaceId,
          title: `permissions ${c.name}`,
          provider: c.provider,
          providerProfileId: "cliproxyapi",
          model: c.model,
          effort: "low",
          permissionMode: PermissionMode.READ_ONLY,
          clientRequestId: `perm-${c.name}`,
        })
      ).thread!;
      for (let i = 0; i < 600 && (await gw.api.getThread({ threadId: thread.id })).thread?.status === "creating"; i++) await Bun.sleep(100);

      // 1. The thread's READ_ONLY: nothing asks, nothing is written.
      const readOnly = await turn(thread.id, { text: write(file("read-only")) });
      expect([readOnly.turn.status, readOnly.turn.permissionMode, readOnly.prompts.length]).toEqual(["completed", PermissionMode.READ_ONLY, 0]);
      expect(existsSync(join(repo, file("read-only")))).toBe(false);

      // 2. One message in FULL_AUTO: written without a prompt.
      const full = await turn(thread.id, { text: write(file("full-auto")), permissionMode: PermissionMode.FULL_AUTO });
      expect([full.turn.status, full.turn.permissionMode, full.prompts.length]).toEqual(["completed", PermissionMode.FULL_AUTO, 0]);
      expect(existsSync(join(repo, file("full-auto")))).toBe(true);

      // 3. The next message has no override: the thread's READ_ONLY again (Codex must not keep FULL_AUTO).
      const back = await turn(thread.id, { text: write(file("read-only-again")) });
      expect([back.turn.status, back.turn.permissionMode, back.prompts.length]).toEqual(["completed", PermissionMode.READ_ONLY, 0]);
      expect(existsSync(join(repo, file("read-only-again")))).toBe(false);

      // 4. The thread's default becomes ASK: the write asks; allowed, it happens.
      expect((await gw.api.updateThread({ threadId: thread.id, permissionMode: PermissionMode.ASK })).thread?.permissionMode).toBe(PermissionMode.ASK);
      const ask = await turn(thread.id, { text: write(file("ask")) });
      expect([ask.turn.status, ask.turn.permissionMode]).toEqual(["completed", PermissionMode.ASK]);
      expect(ask.prompts.filter((p) => p.kind === InteractionKind.PERMISSION).length).toBeGreaterThan(0);
      expect(existsSync(join(repo, file("ask")))).toBe(true);
      console.info(`${c.name}: ASK prompts: ${ask.prompts.map((p) => p.toolName).join(", ")}`);
    }, 900_000);
  }

  test("claude: a process kept by a background task switches mode before the next turn (sandbox included)", async () => {
    const probe = join(homedir(), `oa-live-outside-${Bun.randomUUIDv7()}.txt`);
    try {
      const thread = (
        await gw.api.createThread({
          projectId,
          workspaceId,
          title: "claude live switch",
          provider: Provider.CLAUDE,
          providerProfileId: "cliproxyapi",
          model: CASES[1].model,
          effort: "low",
          permissionMode: PermissionMode.FULL_AUTO,
          clientRequestId: "perm-claude-live",
        })
      ).thread!;
      for (let i = 0; i < 600 && (await gw.api.getThread({ threadId: thread.id })).thread?.status === "creating"; i++) await Bun.sleep(100);

      // FULL_AUTO with a background task: the process stays after the turn.
      const started = await turn(thread.id, {
        text: "Start the shell command `sleep 240` in the background (Bash with run_in_background: true). Do not wait for it. Reply STARTED.",
      });
      expect([started.turn.status, started.prompts.length]).toEqual(["completed", 0]);
      const live = await gw.api.getThread({ threadId: thread.id });
      expect(live.thread?.backgroundTasks).toBeGreaterThan(0);

      // READ_ONLY on that process: the write is refused without a prompt.
      const readOnly = await turn(thread.id, { text: write("claude-live-read-only.txt"), permissionMode: PermissionMode.READ_ONLY });
      expect([readOnly.turn.status, readOnly.prompts.length]).toEqual(["completed", 0]);
      expect(existsSync(join(repo, "claude-live-read-only.txt"))).toBe(false);

      // ASK on that process: the write asks.
      const ask = await turn(thread.id, { text: write("claude-live-ask.txt"), permissionMode: PermissionMode.ASK });
      expect(ask.prompts.filter((p) => p.kind === InteractionKind.PERMISSION).length).toBeGreaterThan(0);
      expect(existsSync(join(repo, "claude-live-ask.txt"))).toBe(true);

      // FULL_AUTO again: writes in the workspace without asking, and the sandbox is back (outside is refused).
      const full = await turn(thread.id, {
        text:
          `Run exactly these two shell commands, one Bash call each: \`echo hello > claude-live-full.txt\` and \`echo x > ${probe}\`. ` +
          "Do not retry anything that fails and do not ask for other permissions. Reply with what each printed.",
        permissionMode: PermissionMode.FULL_AUTO,
      });
      expect([full.turn.status, full.prompts.length]).toEqual(["completed", 0]);
      expect(existsSync(join(repo, "claude-live-full.txt"))).toBe(true);
      expect(existsSync(probe)).toBe(false);
      expect((await gw.api.getThread({ threadId: thread.id })).thread?.backgroundTasks).toBeGreaterThan(0); // same process
    } finally {
      rmSync(probe, { force: true });
    }
  }, 900_000);
});
