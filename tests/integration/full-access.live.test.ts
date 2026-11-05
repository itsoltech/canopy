/**
 * Live, through the whole stack: UI API -> gateway on PostgreSQL -> a real worker host with Codex and Claude
 * through CLIProxyAPI. A Full auto turn cannot write outside the workspace (sandbox); the same turn in Full
 * access writes there without asking.
 * Opt-in: CANOPY_LIVE=1 with the CLIProxyAPI env (docs/codex-adapter.md#testy-na-żywo).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PermissionMode, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { useLiveProxy } from "./support/live.ts";

const tempDir = tempDirs();
const LIVE = process.env["CANOPY_LIVE"] === "1";
const proxyUrl = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];

const CASES = [
  { name: "codex", provider: Provider.CODEX, model: process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol" },
  { name: "claude", provider: Provider.CLAUDE, model: process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5" },
] as const;

const FINISHED = new Set(["completed", "failed", "interrupted", "cancelled"]);

/** Outside the workspace and outside /tmp (both sandboxes let agents write to /tmp). */
const outside = () => join(homedir(), `canopy-live-full-access-${Bun.randomUUIDv7()}.txt`);

const write = (file: string) =>
  `Run exactly this one shell command: \`echo hello > ${file}\`. ` +
  "If it is blocked or refused, do not try anything else (no other tools, no workarounds) and reply BLOCKED; otherwise reply DONE.";

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)("Full access with a real worker (live)", () => {
  let gw: TestGateway;
  let workspaceId = "";
  let projectId = "";
  let stop = async () => {};
  const probes: string[] = [];

  beforeAll(async () => {
    gw = await startTestGateway();
    const repo = tempDir("canopy-live-full-access-repo-");
    const data = tempDir("canopy-live-full-access-worker-");

    const added = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ name: "live", ownerUserId: gw.userId })),
    );

    await useLiveProxy(gw, added.workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo] });
    const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(data, "data"), clientVersion: "live" });

    const link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: added.credential,
      hello: { workerId: added.workerId, capabilities: ["full_access"], ...(await runtime.runPromise(journalHello())) },
    });

    const serving = serveLink(link, host, runtime);
    stop = async () => {
      link.close();
      await serving;
      await host.close();
      await runtime.dispose();
    };

    projectId = (await gw.api.createProject({ name: "Live full access" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: added.workerId, rootPath: repo, label: "live" }))
      .workspace!.id;
  }, 120_000);

  afterAll(async () => {
    for (const probe of probes) rmSync(probe, { force: true });
    await stop();
    await gw?.close();
  });

  /** Sends one message in a mode and waits for its turn to end. */
  const ran = async (threadId: string, text: string, permissionMode: PermissionMode) => {
    const turnId = (await gw.api.sendMessage({ threadId, text, permissionMode, clientRequestId: Bun.randomUUIDv7() }))
      .turn!.id;

    await eventually(
      () =>
        gw.runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            return (yield* sql<{ status: string }>`SELECT status FROM turns WHERE id = ${turnId}::uuid`)[0]?.status;
          }),
        ),
      (status) => FINISHED.has(status ?? ""),
      300_000,
    );
  };

  for (const c of CASES)
    test(`${c.name}: Full auto cannot write outside the workspace, Full access can`, async () => {
      const thread = (
        await gw.api.createThread({
          projectId,
          workspaceId,
          title: `${c.name} full access`,
          provider: c.provider,
          providerProfileId: "cliproxyapi",
          model: c.model,
          permissionMode: PermissionMode.FULL_AUTO,
        })
      ).thread!;

      await eventually(
        () => gw.api.getThread({ threadId: thread.id }),
        (r) => r.thread?.status === "idle",
        120_000,
      );

      const sandboxed = outside();
      const free = outside();
      probes.push(sandboxed, free);

      await ran(thread.id, write(sandboxed), PermissionMode.FULL_AUTO);
      expect(existsSync(sandboxed)).toBe(false);

      await ran(thread.id, write(free), PermissionMode.FULL_ACCESS);
      expect(existsSync(free)).toBe(true);
    }, 900_000);
});
