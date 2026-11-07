import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { AgentEnvironmentDesiredSchema, PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { treeFingerprint } from "../../apps/worker/src/import/fixtures/install.ts";
import { READABLE_URL_PROSE, URL_BOUNDARIES } from "../../apps/worker/src/import/fixtures/url-boundaries.ts";
import { eventually, failure } from "./support/gateway.ts";
import { importFixture } from "./support/imports.ts";
import { LibraryApply } from "../../apps/gateway/src/imports/library-apply.ts";
import type { LibraryRow } from "../../apps/gateway/src/imports/library-store.ts";

/**
 * CLI import, stack B stage 6 (docs/import.md, "Ustawienia i biblioteka"): defaults of new threads and instruction
 * documents from the CLI homes, with Undo that restores only what nobody changed since.
 */
describe.skipIf(!dockerAvailable)("CLI import: settings and instructions", () => {
  const dir = tempDir("canopy-import-library-");
  const SECRET = "library-secret-CANARY-0042";
  let f: Awaited<ReturnType<typeof importFixture>>;

  const finished = (runId: string) =>
    eventually(
      () => f.gw.api.getImportRun({ runId, items: true }),
      (r) => !["running", "paused"].includes(r.status),
      20_000,
    );

  const library = async () => {
    const { scanId } = await f.gw.api.scanImport({ workerId: f.workerId });
    const { items } = await f.gw.api.listImportLibrary({ scanId });

    return {
      scanId,
      items,
      of: (cli: string, name: string) => items.find((i) => i.agentCli === cli && i.name.includes(name))!,
    };
  };

  const environment = () => f.gw.api.getAgentEnvironment({});

  beforeAll(async () => {
    f = await importFixture(dir, { clis: ["claude", "codex", "grok"], library: true });
    writeFileSync(join(f.home, ".claude", ".credentials.json"), JSON.stringify({ token: SECRET }));
    appendFileSync(join(f.home, ".claude", "CLAUDE.md"), `Deploy key: ${SECRET}\n`);
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  test("unsupported Codex approval gates cannot enter an import plan", async () => {
    const path = join(f.home, ".codex", "config.toml");
    const original = readFileSync(path, "utf8");

    try {
      for (const policy of ['"untrusted"', "{ granular = { sandbox_approval = true } }"]) {
        writeFileSync(path, `sandbox_mode = "workspace-write"\napproval_policy = ${policy}\n`);
        const { scanId, of } = await library();
        const candidate = of("codex", "Permissions");
        expect(candidate.status).toBe("unavailable");
        expect(candidate.reason).toBeTruthy();
        expect(await failure(f.gw.api.startImport({ scanId, library: [{ key: candidate.key }] }))).toContain(
          "Scan again",
        );
      }
    } finally {
      writeFileSync(path, original);
    }
  });

  test("ambiguous URL userinfo never enters instruction storage, environment responses or worker sync", async () => {
    const path = join(f.home, ".claude", "CLAUDE.md");
    const original = readFileSync(path, "utf8");
    const connection = f.gw.core.link.connections.get(f.workerId)!;
    const apply = f.host.environment.apply.bind(f.host.environment);
    const payloads: string[] = [];
    let syncedRevision = 0n;
    connection.hello.capabilities.push("agent_environment_v1");
    f.host.environment.apply = (desired) => {
      payloads.push(toJsonString(AgentEnvironmentDesiredSchema, desired));
      syncedRevision = desired.revision;
      apply(desired);
    };

    try {
      for (const [index, text] of [...URL_BOUNDARIES, READABLE_URL_PROSE].entries()) {
        const readable = text === READABLE_URL_PROSE;
        writeFileSync(path, text);
        const sessionId = crypto.randomUUID();
        const project = join(f.home, ".claude", "projects", f.home.replace(/[^a-zA-Z0-9]/g, "-") + "-project");
        const history = join(project, `${sessionId}.jsonl`);
        writeFileSync(
          history,
          [
            JSON.stringify({
              sessionId,
              cwd: join(f.home, "project"),
              timestamp: new Date().toISOString(),
              type: "user",
              uuid: "u1",
              message: { role: "user", content: text },
            }),
            JSON.stringify({ type: "custom-title", sessionId, customTitle: text }),
          ].join("\n") + "\n",
        );
        const { scanId } = await f.gw.api.scanImport({ workerId: f.workerId });
        const candidates = await f.gw.api.listImportCandidates({ scanId });
        const thread = candidates.candidates.find((candidate) => candidate.nativeId === sessionId)!;
        expect(!!thread).toBe(true);
        expect(thread.title.includes("CANARY"), `boundary case ${index}`).toBe(false);
        expect(thread.preview.includes("CANARY")).toBe(false);

        if (readable) expect(thread.title).toBe(READABLE_URL_PROSE);
        else expect(thread.title).not.toBe(text);
        unlinkSync(history);
        const list = await f.gw.api.listImportLibrary({ scanId });
        expect(toJsonString(ui.ListImportLibraryResponseSchema, list).includes("CANARY")).toBe(false);
        const candidate = list.items.find((item) => item.agentCli === "claude" && item.name.includes("CLAUDE.md"))!;

        const done = await finished((await f.gw.api.startImport({ scanId, library: [{ key: candidate.key }] })).id);

        expect(done.library[0]?.status).toBe("done");
        const snapshot = await environment();
        expect(toJsonString(ui.AgentEnvironmentSnapshotSchema, snapshot).includes("CANARY")).toBe(false);

        if (!readable) expect(toJsonString(ui.AgentEnvironmentSnapshotSchema, snapshot)).not.toContain(text);
        const rows = await f.sql((sql) => sql<{ document: string }>`SELECT document::text FROM instruction_documents`);
        expect(rows.every((row) => !row.document.includes("CANARY"))).toBe(true);

        const plans = await f.sql(
          (sql) => sql<{ value: string }>`SELECT value::text FROM import_library_items WHERE run_id = ${done.id}::uuid`,
        );

        expect(plans.length).toBe(1);
        expect(plans.every((row) => !row.value.includes("CANARY"))).toBe(true);
        await eventually(
          async () => syncedRevision,
          (revision) => revision >= snapshot.revision,
        );
        expect(payloads.every((payload) => !payload.includes("CANARY"))).toBe(true);

        if (readable) {
          expect(toJsonString(ui.AgentEnvironmentSnapshotSchema, snapshot)).toContain(READABLE_URL_PROSE);
          expect(rows.some((row) => row.document.includes(READABLE_URL_PROSE))).toBe(true);
          expect(payloads.some((payload) => payload.includes(READABLE_URL_PROSE))).toBe(true);
        }

        await f.gw.api.undoImportRun({ runId: done.id });
        payloads.length = 0;
      }
    } finally {
      writeFileSync(path, original);
      f.host.environment.apply = apply;
      connection.hello.capabilities = connection.hello.capabilities.filter((c) => c !== "agent_environment_v1");
    }
  }, 120_000);

  test("lists defaults and instructions against Canopy, with what stays out and why", async () => {
    // Codex runs on its own (workspace-write, never asks): Full auto, unlike Claude's Accept edits.
    const codexConfig = join(f.home, ".codex", "config.toml");
    writeFileSync(
      codexConfig,
      readFileSync(codexConfig, "utf8").replace('approval_policy = "on-request"', 'approval_policy = "never"'),
    );
    const scan = await f.gw.api.scanImport({ workerId: f.workerId });
    expect(scan.overview.find((o) => o.agentCli === "claude")?.library).toBeGreaterThan(0);
    const { of } = await library();

    expect(of("claude", "Default model")).toMatchObject({
      status: "new",
      current: "Default",
      proposed: "opus",
      suggested: true,
    });
    expect(of("codex", "Default model")).toMatchObject({ status: "new", proposed: "gpt-fixture" });
    // Claude asks to accept edits, Codex runs on its own: one default, so the owner chooses.
    const claudeMode = of("claude", "Permissions");
    expect(claudeMode).toMatchObject({ status: "new", proposed: "Accept edits", suggested: false });
    expect(claudeMode.warnings).toContain("The CLIs differ here. Choose one.");
    expect(of("claude", "CLAUDE.md")).toMatchObject({ status: "new", suggested: true });
    expect(of("claude", "CLAUDE.md").warnings.join(" ")).toContain("possible secret");
    expect(of("grok", "AGENTS.md")).toMatchObject({ status: "unavailable" });
    expect(of("claude", "Hooks")).toMatchObject({ status: "unavailable" });
    expect(of("claude", "Default effort").reason).toContain("no default effort");
  });

  test("imports the chosen defaults and documents; the device's CLI files stay as they were", async () => {
    const before = treeFingerprint(f.home);
    const { scanId, of } = await library();

    // One permission mode at most; an item that stays out cannot be chosen.
    expect(
      await failure(
        f.gw.api.startImport({
          scanId,
          library: [{ key: of("claude", "Permissions").key }, { key: of("codex", "Permissions").key }],
        }),
      ),
    ).toContain("Choose one permission mode");
    expect(await failure(f.gw.api.startImport({ scanId, library: [{ key: of("claude", "Hooks").key }] }))).toContain(
      "Scan again",
    );

    const run = await f.gw.api.startImport({
      scanId,
      library: ["Default model", "Permissions", "CLAUDE.md"]
        .map((name) => ({ key: of("claude", name).key }))
        .concat([{ key: of("codex", "AGENTS.md").key }]),
    });

    const done = await finished(run.id);

    expect(done.status).toBe("completed");
    expect(done.library.map((l) => l.status)).toEqual(["done", "done", "done", "done"]);
    const { user } = await f.gw.api.getSettings({});
    expect(user?.threadDefaults?.models.find((m) => m.provider === Provider.CLAUDE)?.model).toBe("opus");
    expect(user?.threadDefaults?.permissionMode).toBe(PermissionMode.ACCEPT_EDITS);

    const documents = (await environment()).documents;
    const claude = documents.find((d) => d.harness === "claude")!;
    expect(claude.name).toBe("Claude Code CLAUDE.md (Import laptop)");
    expect(claude).toMatchObject({ platformHome: true, deviceHome: false });
    expect(claude.selector?.workerIds).toEqual([f.workerId]);
    expect(claude.fragments[0]?.content).toContain("Answer in short sentences.");
    expect(claude.fragments[0]?.content).not.toContain(SECRET);
    expect(documents.some((d) => d.harness === "codex" && d.name.startsWith("Codex AGENTS.md"))).toBe(true);
    expect(treeFingerprint(f.home)).toBe(before);

    const again = await library();
    expect(again.of("claude", "CLAUDE.md").status).toBe("imported");
    expect(again.of("claude", "Default model").status).toBe("same");
  });

  test("Undo restores what nobody changed and keeps what the owner changed since", async () => {
    const first = (await f.gw.api.listImportRuns({})).runs.find((r) => r.library.length === 4)!;
    // The owner edits the Codex document after the import.
    const env = await environment();
    const codex = env.documents.find((d) => d.harness === "codex")!;
    const edited = create(ui.InstructionDocumentSchema, { ...codex, name: `${codex.name} edited` });
    await f.gw.api.saveInstructionDocument({ document: edited, expectedRevision: env.revision });

    const undone = await f.gw.api.undoImportRun({ runId: first.id });
    expect(undone.status).toBe("undone");
    const statuses = new Map(undone.library.map((l) => [l.name, l.status]));
    expect(statuses.get("Claude Code CLAUDE.md (Import laptop)")).toBe("undone");
    expect([...statuses.entries()].find(([n]) => n.startsWith("Codex AGENTS.md"))?.[1]).toBe("kept");

    const documents = (await environment()).documents;
    expect(documents.some((d) => d.name === "Claude Code CLAUDE.md (Import laptop)")).toBe(false);
    expect(documents.some((d) => d.name.endsWith("edited"))).toBe(true);
    const { user } = await f.gw.api.getSettings({});
    expect(user?.threadDefaults?.models.some((m) => m.provider === Provider.CLAUDE)).toBe(false);
    expect(user?.threadDefaults?.permissionMode ?? PermissionMode.UNSPECIFIED).toBe(PermissionMode.UNSPECIFIED);
  });

  test("a document with the same name: keep both or replace, and Undo puts the owner's one back", async () => {
    const name = "Claude Code CLAUDE.md (Import laptop)";
    const env = await environment();
    await f.gw.api.saveInstructionDocument({
      document: create(ui.InstructionDocumentSchema, {
        name,
        harness: "claude",
        platformHome: true,
        selector: { everyone: true },
        fragments: [{ id: "own", name: "own", content: "The owner's own text" }],
      }),
      expectedRevision: env.revision,
    });
    const { scanId, of } = await library();
    const item = of("claude", "CLAUDE.md");
    expect(item).toMatchObject({ status: "conflict", actions: ["replace", "keep_both"], suggested: false });

    const both = await finished(
      (await f.gw.api.startImport({ scanId, library: [{ key: item.key, action: "keep_both" }] })).id,
    );

    expect(both.library[0]?.status).toBe("done");
    expect((await environment()).documents.some((d) => d.name === `${name} (2)`)).toBe(true);
    await f.gw.api.undoImportRun({ runId: both.id });
    expect((await environment()).documents.some((d) => d.name === `${name} (2)`)).toBe(false);

    const third = await library();

    const replaced = await finished(
      (
        await f.gw.api.startImport({
          scanId: third.scanId,
          library: [{ key: third.of("claude", "CLAUDE.md").key, action: "replace" }],
        })
      ).id,
    );

    expect((await environment()).documents.find((d) => d.name === name)?.fragments[0]?.content).toContain(
      "Answer in short sentences.",
    );
    await f.gw.api.undoImportRun({ runId: replaced.id });
    expect((await environment()).documents.find((d) => d.name === name)?.fragments[0]?.content).toBe(
      "The owner's own text",
    );
  });

  test("a change and its receipt commit together; a failed Undo keeps its item and the next Undo finishes it", async () => {
    const { scanId, of } = await library();

    const run = await finished(
      (await f.gw.api.startImport({ scanId, library: [{ key: of("claude", "Default model").key }] })).id,
    );

    expect(run.library[0]?.status).toBe("done");

    const model = async () =>
      (await f.gw.api.getSettings({})).user?.threadDefaults?.models.find((m) => m.provider === Provider.CLAUDE)?.model;

    const [row] = await f.sql(
      (sql) => sql<LibraryRow>`SELECT * FROM import_library_items WHERE run_id = ${run.id}::uuid`,
    );

    // A restore whose receipt has no item to land on is rolled back: nothing changes without its record.
    expect(
      await new LibraryApply(f.gw.core, f.sql).undo({ ...row!, id: crypto.randomUUID() }).then(
        () => "restored",
        () => "rolled back",
      ),
    ).toBe("rolled back");
    expect(await model()).toBe("opus");

    // The settings store fails once: the run is undone, the setting stays done with the reason, and Undo retries it.
    const update = f.gw.core.updateUserSettings.bind(f.gw.core);
    f.gw.core.updateUserSettings = () => Promise.reject(new Error("the settings store is busy"));

    try {
      expect(await failure(f.gw.api.undoImportRun({ runId: run.id }))).toContain("could not be put back");
    } finally {
      f.gw.core.updateUserSettings = update;
    }

    const failed = await f.gw.api.getImportRun({ runId: run.id });
    expect(failed.status).toBe("undone");
    expect(failed.library[0]).toMatchObject({ status: "done" });
    expect(failed.library[0]?.error).toContain("settings store is busy");
    expect(await model()).toBe("opus");

    const retried = await f.gw.api.undoImportRun({ runId: run.id });
    expect(retried.library[0]).toMatchObject({ status: "undone", error: "" });
    expect(await model()).toBeUndefined();
  });

  test("Full access is never imported: a CLI that skips every prompt maps to nothing", async () => {
    writeFileSync(
      join(f.home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
    );
    writeFileSync(join(f.home, ".codex", "config.toml"), 'sandbox_mode = "danger-full-access"\n');
    const { scanId, items } = await library();
    const modes = items.filter((i) => i.name === "Permissions of new threads");

    expect(modes.every((m) => m.status === "unavailable" && m.reason.includes("never sets Full access"))).toBe(true);
    expect(await failure(f.gw.api.startImport({ scanId, library: [{ key: modes[0]!.key }] }))).toContain("Scan again");
  });
});
