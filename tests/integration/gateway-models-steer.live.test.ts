/**
 * Live, through the whole stack: UI API (gRPC, service token) -> gateway on PostgreSQL -> a real worker host
 * with Codex and Claude through CLIProxyAPI. The UI sees the worker's model catalog, picks a model and an
 * effort, and steers a message into the running turn; it shows up in that turn, where it entered.
 * Opt-in: CANOPY_LIVE=1 with the CLIProxyAPI env (docs/codex-adapter.md#testy-na-żywo).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";
import { useLiveProxy } from "./support/live.ts";

const tempDir = tempDirs();

const LIVE = process.env["CANOPY_LIVE"] === "1";
const proxyUrl = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];

const CASES = [
  { name: "Codex", provider: Provider.CODEX, model: process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol" },
  { name: "Claude", provider: Provider.CLAUDE, model: process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5" },
] as const;

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)("UI API: models, effort and steer with a real worker (live)", () => {
  let gw: TestGateway;
  let workerId = "";
  let workspaceId = "";
  let projectId = "";
  let stop = async () => {};

  beforeAll(async () => {
    gw = await startTestGateway();
    const repo = tempDir("oa-live-ui-repo-");
    const data = tempDir("oa-live-ui-worker-");
    // A real worker with both providers through the proxy (its key is a secret reference, as with the CLI).
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
    projectId = (await gw.api.createProject({ name: "Live models" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo, label: "live" })).workspace!.id;
  }, 120_000);

  afterAll(async () => {
    await stop();
    await gw?.close();
  });

  test("the worker's catalog reaches the UI for both providers", async () => {
    const catalog = await eventually(
      () => gw.api.listModels({ workerId }),
      (r) => (r.workers[0]?.profiles.length ?? 0) >= 4,
      90_000,
    );
    const profiles = catalog.workers[0]!.profiles;
    for (const c of CASES) {
      const live = profiles.find((p) => p.provider === c.provider && p.profileId === "cliproxyapi");
      expect(live?.detail).toBe("");
      expect(live?.models.some((m) => (m.id === c.model || m.resolvedModel === c.model) && m.efforts.includes("low"))).toBe(true);
    }
    console.info(profiles.map((p) => `${Provider[p.provider]}/${p.profileId}: ${p.models.length}${p.detail ? ` (${p.detail})` : ""}`).join("; "));
  }, 120_000);

  for (const c of CASES) {
    test(`${c.name}: a thread on a chosen model and effort; a steered message joins the running turn`, async () => {
      expect(
        (await gw.api.createThread({ projectId, workspaceId, title: "x", provider: c.provider, providerProfileId: "cliproxyapi", model: c.model, effort: "nope" }).catch((e: Error) => e)) instanceof
          Error,
      ).toBe(true);
      const thread = (
        await gw.api.createThread({
          projectId,
          workspaceId,
          title: `steer ${c.name}`,
          provider: c.provider,
          providerProfileId: "cliproxyapi",
          model: c.model,
          effort: "low",
          // FULL_AUTO: the command runs without a permission prompt (Claude: in the sandbox).
          permissionMode: PermissionMode.FULL_AUTO,
          initialMessage: "Run the shell command `sleep 8; echo first` (one command, wait for it). Then reply with its output, one line.",
          clientRequestId: `live-${c.name}`,
        })
      ).thread!;

      let steer: ui.Steer | undefined;
      const updates = await watchUntil(
        gw.api,
        thread.id,
        (u) => u.some((x) => x.change.case === "turn" && x.change.value.status === "completed") || u.some((x) => x.change.case === "turn" && x.change.value.status === "failed"),
        (update) => {
          // Steer once the command runs.
          const event = update.change.case === "event" ? update.change.value.event : undefined;
          if (!steer && event?.body.case === "itemStarted" && event.body.value.item?.content.case === "commandExecution") {
            steer = { id: "" } as ui.Steer;
            void gw.api
              .sendMessage({ threadId: thread.id, text: "Change of plan from the user: your final answer must end with the word BANANA.", clientRequestId: `steer-${c.name}`, delivery: ui.MessageDelivery.STEER })
              .then((r) => (steer = r.steer));
          }
        },
        240_000,
      );
      expect(steer?.id).toBeTruthy();
      const turn = updates.flatMap((u) => (u.change.case === "turn" ? [u.change.value] : [])).at(-1)!;
      expect([turn.status, turn.model, turn.effort]).toEqual(["completed", c.model, "low"]);

      const view = (await watchUntil(gw.api, thread.id, (u) => u.length >= 1))[0]!;
      const snapshot = view.change.case === "snapshot" ? view.change.value : undefined;
      expect(snapshot?.steers.map((s) => [s.id, s.status, s.turnId])).toEqual([[steer!.id, "delivered", turn.id]]);
      const items = snapshot?.items.filter((i) => i.turnId === turn.id).map((i) => i.item!) ?? [];
      const entered = items.findIndex((i) => i.content.case === "userMessage" && i.content.value.clientId === steer!.id);
      const command = items.findIndex((i) => i.content.case === "commandExecution");
      expect(entered).toBeGreaterThan(command);
      const answer = items.filter((i) => i.content.case === "agentMessage").map((i) => (i.content.case === "agentMessage" ? i.content.value.text : "")).join("\n");
      expect(answer).toContain("BANANA");
      expect(snapshot?.turns).toHaveLength(1); // nothing fell back to the queue
    }, 300_000);
  }
});
