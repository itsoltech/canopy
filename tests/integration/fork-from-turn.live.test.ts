/**
 * Live, through the whole stack: UI API -> gateway on PostgreSQL -> a real worker host with Codex and Claude
 * through a global CLIProxyAPI instance. "Fork from here" on turn 2 of a three-turn thread: the fork is a new
 * main thread whose provider history ends at turn 2 (Codex thread/fork with lastTurnId, Claude forkSession up to
 * the turn's last entry), so asked about the last message it names turn 2's word, never turn 3's.
 * Opt-in: OA_LIVE=1 with the CLIProxyAPI env (docs/codex-adapter.md#testy-na-żywo).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceLogin, Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

const LIVE = process.env["OA_LIVE"] === "1";
const proxyUrl = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["OA_LIVE_CLIPROXYAPI_KEY"];

const CASES = [
  { name: "codex", provider: Provider.CODEX, model: process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol" },
  { name: "claude", provider: Provider.CLAUDE, model: process.env["OA_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5" },
] as const;

const ENDED = new Set(["completed", "failed", "interrupted", "cancelled"]);
const WORDS = ["APPLE", "BANANA", "CHERRY"];

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)("UI API: fork from a turn with a real worker (live)", () => {
  let gw: TestGateway;
  let projectId = "";
  let workspaceId = "";
  let stop = async () => {};
  const dirs: string[] = [];

  beforeAll(async () => {
    gw = await startTestGateway();
    const repo = mkdtempSync(join(tmpdir(), "oa-live-fork-repo-"));
    const data = mkdtempSync(join(tmpdir(), "oa-live-fork-worker-"));
    dirs.push(repo, data);
    const added = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: "live", ownerUserId: gw.userId })));
    const workerId = added.workerId;
    await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.setWorkerConfig(
          workerId,
          { allowedRoots: [repo], codex: { enabled: true, deviceLogin: DeviceLogin.NONE }, claude: { enabled: true, deviceLogin: DeviceLogin.NONE } },
          gw.userId,
          {},
        ),
      ),
    );
    // One global instance per harness, on every worker (Settings → Providers).
    for (const harness of [Provider.CODEX, Provider.CLAUDE]) {
      await gw.api.saveProviderInstance({ harness, id: "cliproxyapi", create: true, label: "CLIProxyAPI", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: proxyUrl!, apiKey: proxyKey!, allWorkers: true });
    }
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
    projectId = (await gw.api.createProject({ name: "Live fork" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo, label: "live" })).workspace!.id;
    // Both instances applied and available on the worker before a thread picks them.
    await eventually(
      async () => (await gw.api.getOverview({})).workers.find((w) => w.id === workerId)?.profiles ?? [],
      (profiles) => profiles.filter((p) => p.id === "cliproxyapi" && p.available).flatMap((p) => p.providers).length >= 2,
      120_000,
    );
  }, 240_000);

  afterAll(async () => {
    await stop();
    await gw?.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  async function snapshot(threadId: string): Promise<ui.ThreadSnapshot | undefined> {
    const first = (await watchUntil(gw.api, threadId, (u) => u.length >= 1))[0];
    return first?.change.case === "snapshot" ? first.change.value : undefined;
  }

  async function ready(threadId: string) {
    for (let i = 0; i < 600 && (await gw.api.getThread({ threadId })).thread?.status === "creating"; i++) await Bun.sleep(100);
    expect((await gw.api.getThread({ threadId })).thread?.status).toBe("idle");
  }

  /** Sends a message, waits for its turn to end and returns the turn with the agent's answer in it. */
  async function turn(threadId: string, text: string): Promise<{ turn: ui.Turn; answer: string }> {
    const turnId = (await gw.api.sendMessage({ threadId, text, clientRequestId: Bun.randomUUIDv7() })).turn!.id;
    const done = await eventually(
      () => snapshot(threadId),
      (s) => s?.turns.some((t) => t.id === turnId && ENDED.has(t.status)) ?? false,
      300_000,
    );
    const answer = (done?.items ?? [])
      .filter((i) => i.turnId === turnId && i.item?.content.case === "agentMessage")
      .map((i) => (i.item?.content.case === "agentMessage" ? i.item.content.value.text : ""))
      .join("\n");
    return { turn: done!.turns.find((t) => t.id === turnId)!, answer };
  }

  for (const c of CASES) {
    test(`${c.name}: fork at turn 2 of 3 remembers turn 2 as the last message, not turn 3`, async () => {
      const source = (
        await gw.api.createThread({ projectId, workspaceId, title: `fork ${c.name}`, provider: c.provider, providerProfileId: "cliproxyapi", model: c.model, effort: "low" })
      ).thread!;
      await ready(source.id);
      const turns: ui.Turn[] = [];
      for (const [i, word] of WORDS.entries()) {
        const sent = await turn(source.id, `Message number ${i + 1}. The secret word of this message is ${word}. Reply with OK only, no tools.`);
        expect(sent.turn.status).toBe("completed");
        turns.push(sent.turn);
      }

      const fork = (await gw.api.createThread({ forkThreadId: source.id, forkAtTurnId: turns[1]!.id })).thread!;
      expect([fork.kind, fork.forkSourceThreadId, fork.forkAfterTurnOrdinal, fork.provider, fork.providerProfileId, fork.model]).toEqual([
        ui.ThreadKind.MAIN, source.id, 2, c.provider, "cliproxyapi", c.model,
      ]);
      await ready(fork.id);
      const inherited = (await snapshot(fork.id))?.turns.filter((t) => t.inherited).map((t) => t.ordinal);
      expect(inherited).toEqual([1, 2]);

      const asked = await turn(fork.id, "What did I say in my last message before this one? Answer with its secret word only, no tools.");
      console.info(`${c.name} fork answer: ${asked.answer}`);
      expect(asked.turn.status).toBe("completed");
      expect(asked.answer.toUpperCase()).toContain("BANANA");
      expect(asked.answer.toUpperCase()).not.toContain("CHERRY");
    }, 900_000);
  }
});
