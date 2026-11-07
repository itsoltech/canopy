import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toJsonString } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { treeFingerprint } from "../../apps/worker/src/import/fixtures/install.ts";
import { failure } from "./support/gateway.ts";
import { importFixture } from "./support/imports.ts";

/** Settings → Import, stage 1 (docs/import.md): scan and preview over the worker link, owner-scoped and read-only. */
describe.skipIf(!dockerAvailable)("CLI import: discovery and preview", () => {
  const dir = tempDir("canopy-import-scan-");
  const CANARY = "xai-CANARYcanaryCANARYcanaryCANARYcanary12";
  let f: Awaited<ReturnType<typeof importFixture>>;

  beforeAll(async () => {
    f = await importFixture(dir);
    // A secret in the Grok login file and inside a prompt: the scan must not carry it.
    writeFileSync(join(f.home, ".grok", "auth.json"), JSON.stringify({ api_key: CANARY }));
    const claude = join(f.home, ".claude", "projects", "-planted");
    mkdirSync(claude, { recursive: true });
    const id = crypto.randomUUID();
    writeFileSync(
      join(claude, `${id}.jsonl`),
      `${JSON.stringify({ type: "user", uuid: "u", sessionId: id, cwd: join(f.home, "project"), timestamp: "2026-11-01T10:00:00Z", version: "2.1.308", message: { role: "user", content: `use ${CANARY} for the deploy` } })}\n`,
    );
  }, 120_000);

  afterEach(async () => {
    await f?.restore();
  });

  afterAll(async () => {
    await f?.close();
  });

  test("scans the worker's CLI homes without changing them and lists candidates by directory", async () => {
    const before = treeFingerprint(f.home);
    const scan = await f.gw.api.scanImport({ workerId: f.workerId });
    expect(treeFingerprint(f.home)).toBe(before);
    expect(scan.overview.map((o) => [o.agentCli, o.threads])).toEqual([
      ["claude", 3],
      ["codex", 2],
      ["grok", 1],
    ]);
    expect(toJsonString(ui.ScanImportResponseSchema, scan)).not.toContain(CANARY);

    const all = await f.gw.api.listImportCandidates({ scanId: scan.scanId, filter: { includeSubagents: true } });
    expect(all.total).toBe(6);
    expect(all.groups.map((g) => g.directory).sort()).toEqual([join(f.home, "other"), join(f.home, "project")]);
    expect(all.groups.every((g) => g.suggestion?.kind === "create_project")).toBe(true);
    expect(all.candidates.every((c) => c.continueMode === "native")).toBe(true);
    // Later stages read Codex and Grok history too; until then only Claude threads can be chosen.
    expect(all.candidates.map((c) => [c.agentCli, c.status]).sort()).toEqual(
      all.candidates.map((c) => [c.agentCli, c.agentCli === "claude" ? "new" : "unsupported"]).sort(),
    );
    expect(all.importable).toBe(3);
    const planted = all.candidates.find((c) => c.flaggedSecrets > 0)!;
    expect(planted.preview).toContain("[redacted]");
    expect(toJsonString(ui.ListImportCandidatesResponseSchema, all)).not.toContain(CANARY);

    const codex = await f.gw.api.listImportCandidates({
      scanId: scan.scanId,
      filter: { agentClis: ["codex"], directory: join(f.home, "project") },
    });

    expect(codex.candidates.map((c) => c.agentCli)).toEqual(["codex"]);

    const old = await f.gw.api.listImportCandidates({
      scanId: scan.scanId,
      filter: { until: timestampFromMs(Date.parse("2000-01-01")) },
    });

    expect(old.total).toBe(0);
    const searched = await f.gw.api.listImportCandidates({ scanId: scan.scanId, filter: { search: "fixture_other" } });
    expect(searched.candidates.map((c) => c.preview)).toEqual(["Hello from FIXTURE_OTHER", "Hello from FIXTURE_OTHER"]);
  });

  test("suggests an existing project's workspace for directories inside it", async () => {
    const project = (await f.gw.api.createProject({ name: "Fixture project" })).project!;
    await f.gw.api.createWorkspace({ projectId: project.id, workerId: f.workerId, rootPath: join(f.home, "project") });
    const scan = await f.gw.api.scanImport({ workerId: f.workerId });
    const list = await f.gw.api.listImportCandidates({ scanId: scan.scanId });
    const group = list.groups.find((g) => g.directory === join(f.home, "project"))!;
    expect(group.suggestion).toMatchObject({
      kind: "workspace",
      projectId: project.id,
      projectName: "Fixture project",
    });
  });

  test("refuses other owners' workers, workers without the capability, and unknown or expired scans", async () => {
    const other = await f.gw.runtime.runPromise(
      (await import("@canopy/gateway/store")).GatewayStore.use((s) => s.ensureUser("other@localhost", "Other")),
    );

    const foreign = await f.gw.addWorker("Someone else's laptop");
    await f.sql((sql) => sql`UPDATE workers SET owner_user_id = ${other}::uuid WHERE id = ${foreign.workerId}::uuid`);
    expect(await failure(f.gw.api.scanImport({ workerId: foreign.workerId }))).toContain("Worker not found");
    expect(await failure(f.gw.api.scanImport({ workerId: "not-a-uuid" }))).toContain("Worker not found");
    // The fixture gateway's scripted worker does not announce cli_import_v1.
    expect(await failure(f.gw.api.scanImport({ workerId: f.gw.workerId }))).toContain("Update the worker");
    expect(await failure(f.gw.api.listImportCandidates({ scanId: crypto.randomUUID() }))).toContain("expired");
  });

  test("an offline worker cannot be scanned", async () => {
    f.disconnect();
    expect(await failure(f.gw.api.scanImport({ workerId: f.workerId }))).toContain("offline");
    await f.connect();
  });
});
