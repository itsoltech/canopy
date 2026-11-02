import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Provider, PermissionMode } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayStore } from "@open-agents/gateway/store";
import { tempDirs } from "@open-agents/testing";
import { journalHello, openGatewayLink } from "@open-agents/worker/gateway-link";
import { Journal } from "@open-agents/worker/journal";
import { serveLink, WorkerHost } from "@open-agents/worker/runtime";
import { ManagedRuntime } from "effect";
import { answers, startTestGateway, watchUntil } from "./support/gateway.ts";
import { liveProxyReady, useLiveProxy } from "./support/live.ts";

// Private card delivery is optional; the file stays outside the repo and its contents are never logged.
const privateFile = process.env["OA_LIVE_PROXY_FILE"];
const connection: { url?: string; key?: string } = privateFile ? await Bun.file(privateFile).json() : {};
const proxyUrl = connection.url ?? process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = connection.key ?? process.env["OA_LIVE_CLIPROXYAPI_KEY"];

describe.skipIf(process.env["OA_LIVE"] !== "1" || !proxyUrl || !proxyKey || !dockerAvailable)("no-project real worker through CLIProxyAPI", () => {
  const makeTemp = tempDirs();
  test("CreateThread creates a scratch directory and the agent's pwd is that directory", async () => {
    const gw = await startTestGateway();
    const root = makeTemp("oa-scratch-live-root-");
    const data = makeTemp("oa-scratch-live-data-");
    const worker = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ ownerUserId: gw.userId, name: "scratch-live" })));
    const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(data, "data"), clientVersion: "scratch-live" });
    let serving: ReturnType<typeof serveLink> | undefined;
    let closeLink = () => {};
    try {
      await useLiveProxy(gw, worker.workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [root], harnesses: [Provider.CODEX] });
      const link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential: worker.credential,
        hello: { workerId: worker.workerId, ...(await runtime.runPromise(journalHello())) } });
      closeLink = () => link.close();
      serving = serveLink(link, host, runtime);
      await liveProxyReady(gw, worker.workerId, [Provider.CODEX]);
      const project = (await gw.api.getOverview({})).projects.find((p) => p.kind === "scratch")!;
      const workspace = project.workspaces.find((w) => w.workerId === worker.workerId)!;
      expect(existsSync(workspace.rootPath)).toBe(false);
      const thread = (await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX,
        providerProfileId: "cliproxyapi", model: process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol", permissionMode: PermissionMode.READ_ONLY,
        initialMessage: "Run pwd using your shell tool. Reply with only the absolute path printed by pwd. Do not change directories.",
      })).thread!;
      const updates = await watchUntil(gw.api, thread.id, (list) => list.some((u) =>
        u.change.case === "turn" && ["completed", "failed", "interrupted"].includes(u.change.value.status) ||
        u.change.case === "snapshot" && u.change.value.turns.some((t) => ["completed", "failed", "interrupted"].includes(t.status))), undefined, 180_000);
      expect(answers(updates).join("\n")).toContain(thread.cwd);
      expect(existsSync(thread.cwd)).toBe(true);
      expect(thread.cwd).toBe(join(root, ".open-agents", "scratch", gw.userId, thread.id));
      const turns = await gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(thread.id)));
      expect(turns[0]?.status).toBe("completed");
      // Verify a shell command was actually used, not just an answer inferred from the prompt.
      const snapshot = await gw.api.getThread({ threadId: thread.id });
      expect(snapshot.thread?.cwd).toBe(thread.cwd);
      const finished = updates.flatMap((u) => u.change.case === "event" && u.change.value.event?.body.case === "itemCompleted" ? [u.change.value.event.body.value.item] :
        u.change.case === "snapshot" ? u.change.value.items.map((i) => i.item) : []);
      expect(finished.some((item) => item?.content.case === "commandExecution" && item.content.value.command.includes("pwd"))).toBe(true);
      await gw.api.setThreadArchived({ threadId: thread.id, archived: true });
      expect(existsSync(thread.cwd)).toBe(true);
    } finally {
      closeLink();
      await serving;
      await host.close();
      await runtime.dispose();
      await gw.close();
    }
  }, 240_000);
});
