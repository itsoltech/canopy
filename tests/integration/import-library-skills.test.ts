import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { connectors, ui } from "@canopy/contracts";
import { GatewayStore } from "@canopy/gateway/store";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { treeFingerprint } from "../../apps/worker/src/import/fixtures/install.ts";
import { URL_BOUNDARIES } from "../../apps/worker/src/import/fixtures/url-boundaries.ts";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";
import { importFixture } from "./support/imports.ts";
import { sourceRepository } from "./support/skill-sources.ts";
import { undoSkill } from "../../apps/gateway/src/imports/library-apply-skills.ts";
import type { LibraryRow } from "../../apps/gateway/src/imports/library-store.ts";

/**
 * CLI import, stack B stage 7 (docs/import.md, "Skille i pluginy"): skills of every CLI and of ~/.agents into the
 * library, commands and prompts as skills on request, marketplaces from their repositories, plugins listed only.
 */
describe.skipIf(!dockerAvailable)("CLI import: skills, commands and marketplaces", () => {
  const dir = tempDir("canopy-import-skills-");
  let f: Awaited<ReturnType<typeof importFixture>>;

  const finished = (runId: string) =>
    eventually(
      () => f.gw.api.getImportRun({ runId, items: true }),
      (r) => !["running", "paused"].includes(r.status),
      30_000,
    );

  const library = async () => {
    const { scanId } = await f.gw.api.scanImport({ workerId: f.workerId });
    const { items } = await f.gw.api.listImportLibrary({ scanId });

    return {
      scanId,
      items,
      of: (kind: string, name: string) => items.filter((i) => i.kind === kind && i.name === name),
    };
  };

  const environment = () => f.gw.api.getAgentEnvironment({});

  beforeAll(async () => {
    const repo = sourceRepository(dir, "market");
    repo.skill("skills/upstream", "repository-review", "Upstream definition.");
    repo.file(
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        name: "fixture-market",
        owner: { name: "Fixture" },
        plugins: [{ name: "review", source: "./plugins/review" }],
      }),
    );
    repo.file(
      "plugins/review/.claude-plugin/plugin.json",
      JSON.stringify({ name: "review", description: "Fixture plugin." }),
    );
    repo.commit();

    const gateway = await startTestGateway({
      skillSources: { fixtureRepo: (url) => (url === "https://github.com/fixture/market.git" ? repo.bare : undefined) },
    });

    f = await importFixture(join(dir, "machine"), { clis: ["claude", "codex", "grok"], library: true, gateway });
  }, 120_000);

  afterAll(async () => {
    await f?.close();
    await f?.gw.close();
  });

  test("one candidate per skill across CLIs, commands opt-in, marketplaces once, plugins listed with what to do", async () => {
    const { of } = await library();
    const review = of("skill", "fixture-review");

    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ status: "new", suggested: true, agentClis: ["claude", "codex"], files: 2 });
    expect(of("skill", "grok-only")[0]).toMatchObject({ status: "new", agentClis: ["grok"] });
    expect(of("skill", "shared-notes")[0]?.detail).toContain("from https://github.com/fixture/skills.git");
    expect(of("command", "git-commit")[0]).toMatchObject({ status: "new", suggested: false });
    expect(of("command", "explain")[0]).toMatchObject({ status: "new", suggested: false });
    expect(of("marketplace", "fixture-market")).toHaveLength(1);
    expect(of("marketplace", "fixture-market")[0]).toMatchObject({ status: "new", agentClis: ["claude", "codex"] });
    expect(of("marketplace", "local-market")[0]?.status).toBe("unavailable");
    expect(of("plugin", "review@fixture-market")[0]?.reason).toContain("Approve each one in Agent environment");
  });

  test("imports skills, a command as a skill and a marketplace, for this worker's Canopy homes only", async () => {
    const before = treeFingerprint(f.home);
    const { scanId, of } = await library();

    const run = await f.gw.api.startImport({
      scanId,
      library: [
        of("skill", "fixture-review")[0]!,
        of("command", "git-commit")[0]!,
        of("marketplace", "fixture-market")[0]!,
      ].map((c) => ({ key: c.key })),
    });

    const done = await finished(run.id);

    expect(done.library.map((l) => [l.name, l.status, l.error])).toEqual([
      ["fixture-review", "done", ""],
      ["git-commit", "done", ""],
      ["fixture-market", "done", ""],
    ]);
    const env = await environment();
    const skill = env.skills.find((s) => s.name === "fixture-review")!;
    expect(skill).toMatchObject({ platformHome: true, deviceHome: false, harnesses: ["claude", "codex"] });
    expect(skill.selector?.workerIds).toEqual([f.workerId]);
    expect(skill.artifact?.files.find((x) => x.path === "scripts/run.sh")?.executable).toBe(true);
    const command = env.skills.find((s) => s.name === "git-commit")!;
    expect(new TextDecoder().decode(command.artifact!.files[0]!.content)).toContain("Write a short commit message");
    expect(env.marketplaces.some((m) => m.name === "fixture-market")).toBe(true);
    // Plugins are never activated by an import.
    expect(env.plugins).toHaveLength(0);
    expect(treeFingerprint(f.home)).toBe(before);

    const again = await library();
    expect(again.of("skill", "fixture-review")[0]?.status).toBe("imported");
    expect(again.of("marketplace", "fixture-market")[0]?.status).toBe("imported");
  });

  test("two versions of one name: choose one; Replace adds a version and Undo rolls it back", async () => {
    appendFileSync(join(f.home, ".claude", "skills", "fixture-review", "SKILL.md"), "A newer line.\n");
    const { scanId, of } = await library();
    const versions = of("skill", "fixture-review");
    expect(versions.map((v) => v.status).toSorted()).toEqual(["conflict", "same"]);
    const newer = versions.find((v) => v.status === "conflict")!;
    expect(newer.actions).toEqual(["replace"]);
    expect(newer.warnings).toContain("Another version has this name. Choose one.");

    const run = await finished(
      (await f.gw.api.startImport({ scanId, library: [{ key: newer.key, action: "replace" }] })).id,
    );

    expect(run.library[0]?.status).toBe("done");
    const replaced = (await environment()).skills.find((s) => s.name === "fixture-review")!;
    expect(replaced.version).toBe(2n);
    await f.gw.api.undoImportRun({ runId: run.id });
    expect((await environment()).skills.find((s) => s.name === "fixture-review")?.version).toBe(1n);
  });

  test("import-time assignment persists all-computers and tag selectors with Undo and rejects foreign workers", async () => {
    const selection = await library();
    const candidate = selection.of("skill", "grok-only")[0]!;

    const foreignOwner = await f.gw.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("foreign-import@localhost", "Foreign")),
    );

    const foreign = await f.gw.runtime.runPromise(
      GatewayStore.use((store) => store.addWorker({ name: "other-owner", ownerUserId: foreignOwner })),
    );

    const rejected = await finished(
      (
        await f.gw.api.startImport({
          scanId: selection.scanId,
          library: [{ key: candidate.key, skillSelector: { workerIds: [foreign.workerId] } }],
        })
      ).id,
    );

    expect(rejected.library[0]?.status).toBe("failed");
    expect((await environment()).skills.some((s) => s.name === candidate.name)).toBe(false);

    for (const selector of [{ everyone: true }, { tags: ["os:linux"] }]) {
      const next = await library();

      const run = await finished(
        (
          await f.gw.api.startImport({
            scanId: next.scanId,
            library: [{ key: next.of("skill", "grok-only")[0]!.key, skillSelector: selector }],
          })
        ).id,
      );

      expect(run.library[0]?.status).toBe("done");
      const skill = (await environment()).skills.find((s) => s.name === "grok-only")!;
      expect(skill.selector).toMatchObject(selector);
      expect(skill.platformHome).toBe(true);
      expect(skill.deviceHome).toBe(false);
      await f.gw.api.undoImportRun({ runId: run.id });
      expect((await environment()).skills.some((s) => s.id === skill.id)).toBe(false);
    }
  });

  test("Undo removes what the import added and keeps what changed since", async () => {
    const first = (await f.gw.api.listImportRuns({})).runs.find((r) => r.library.some((l) => l.name === "git-commit"))!;
    // The owner uploads a new version of the command skill: it stays.
    const env = await environment();
    const command = env.skills.find((s) => s.name === "git-commit")!;
    await f.gw.api.saveLibrarySkill({
      skill: { ...command, version: 0n },
      files: [
        {
          path: "SKILL.md",
          content: new TextEncoder().encode("---\nname: git-commit\ndescription: Edited.\n---\n\nEdited.\n"),
        },
      ],
      expectedRevision: env.revision,
    });
    const undone = await f.gw.api.undoImportRun({ runId: first.id });
    const status = new Map(undone.library.map((l) => [l.name, l.status]));

    expect(status.get("fixture-review")).toBe("undone");
    expect(status.get("fixture-market")).toBe("undone");
    expect(status.get("git-commit")).toBe("kept");
    const after = await environment();
    expect(after.skills.map((s) => s.name)).toEqual(["git-commit"]);
    expect(after.marketplaces).toHaveLength(0);
    expect(
      await failure(f.gw.api.startImport({ scanId: (await library()).scanId, library: [{ key: "forged.key.value" }] })),
    ).toContain("Scan again");
  });

  test("Undo keeps a skill whose assignment changed since, at the same version", async () => {
    const { scanId, of } = await library();

    const run = await finished(
      (await f.gw.api.startImport({ scanId, library: [{ key: of("skill", "fixture-review")[0]!.key }] })).id,
    );

    expect(run.library[0]?.status).toBe("done");
    // The owner assigns the imported skill to every worker: same version, a different definition.
    const env = await environment();
    const skill = env.skills.find((s) => s.name === "fixture-review")!;
    await f.gw.api.saveLibrarySkill({
      skill: { ...skill, selector: create(ui.EnvironmentSelectorSchema, { everyone: true }) },
      expectedRevision: env.revision,
    });

    const undone = await f.gw.api.undoImportRun({ runId: run.id });
    expect(undone.library[0]?.status).toBe("kept");
    expect((await environment()).skills.find((s) => s.name === "fixture-review")?.selector?.everyone).toBe(true);
  });

  test("Replace and Undo restore the entire repository source and commit the receipt atomically", async () => {
    const account = await f.gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.connectors.save(
          f.gw.userId,
          create(connectors.SaveConnectorAccountRequestSchema, {
            name: "Skill source",
            connectorType: "github",
            authKind: "headers",
            token: "synthetic-source-access-0042",
          }),
        ),
      ),
    );

    const preview = await f.gw.api.previewSkillSource({ command: "fixture/market", credentialAccountId: account.id });

    const added = await f.gw.api.addSkillSource({
      previewId: preview.id,
      paths: ["skills/upstream"],
      assignment: { harnesses: ["claude"], platformHome: true, selector: { workerIds: [f.workerId] } },
      expectedRevision: (await environment()).revision,
    });

    const initial = added.skills.find((s) => s.name === "repository-review")!;
    await f.gw.api.saveLibrarySkill({
      skill: { ...initial, source: { ...initial.source!, autoUpdate: true, pinned: true } },
      expectedRevision: added.revision,
    });
    const before = (await environment()).skills.find((s) => s.id === initial.id)!;
    const local = join(f.home, ".claude", "skills", "repository-review");
    mkdirSync(local, { recursive: true });
    writeFileSync(
      join(local, "SKILL.md"),
      "---\nname: repository-review\ndescription: Local copy.\n---\nLocal content.\n",
    );
    const { scanId, of } = await library();

    const run = await finished(
      (
        await f.gw.api.startImport({
          scanId,
          library: [{ key: of("skill", "repository-review")[0]!.key, action: "replace" }],
        })
      ).id,
    );

    const replaced = (await environment()).skills.find((s) => s.id === initial.id)!;
    expect(replaced.source).toBeUndefined();
    expect(replaced.version).toBe(2n);

    const [row] = await f.sql(
      (sql) => sql<LibraryRow>`SELECT * FROM import_library_items WHERE run_id = ${run.id}::uuid`,
    );

    expect(
      await undoSkill(f.gw.core, { ...row!, id: crypto.randomUUID() }).then(
        () => "restored",
        () => "rolled back",
      ),
    ).toBe("rolled back");
    expect((await environment()).skills.find((s) => s.id === initial.id)?.version).toBe(2n);
    const undone = await f.gw.api.undoImportRun({ runId: run.id });
    expect(undone.library[0]?.status).toBe("undone");
    const restored = (await environment()).skills.find((s) => s.id === initial.id)!;
    expect(restored.version).toBe(before.version);
    expect(toJson(ui.SkillSourceSchema, restored.source!)).toEqual(toJson(ui.SkillSourceSchema, before.source!));
    expect(restored.source?.credentialAccountId).toBe(account.id);
    expect(restored.artifact?.checksum).toBe(before.artifact?.checksum);
    rmSync(local, { recursive: true });
  });

  test("BOM-less UTF-16 skills are unavailable and never enter saved artifacts", async () => {
    const local = join(f.home, ".claude", "skills", "binary-canary");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "SKILL.md"), "---\nname: binary-canary\ndescription: Fixture.\n---\nFixture.\n");
    writeFileSync(join(local, "config.env"), Buffer.from("KEY=synthetic-binary-CANARY-0042\n", "utf16le"));
    const { scanId, of } = await library();
    const item = of("skill", "binary-canary")[0]!;
    expect(item.status).toBe("unavailable");
    expect(item.reason).toContain("config.env");
    expect(await failure(f.gw.api.startImport({ scanId, library: [{ key: item.key }] }))).toContain("Scan again");
    expect((await environment()).skills.some((s) => s.name === "binary-canary")).toBe(false);

    const rows = await f.sql(
      (sql) => sql`SELECT 1 FROM agent_skill_versions WHERE artifact::text LIKE '%synthetic-binary-CANARY%'`,
    );

    expect(rows).toHaveLength(0);
    rmSync(local, { recursive: true });
  });

  test("the gateway rejects credential URLs independently before inserting any marketplace plan", async () => {
    const { scanId } = await library();
    const stored = f.gw.core.imports.stored(scanId);
    const template = stored.scan.library.find((i) => i.kind === "marketplace")!;

    for (const source of [
      ...URL_BOUNDARIES,
      "https://example.test/r.git?%74oken=synthetic-canary",
      "https://example.test/r.git?%2574oken=synthetic-canary",
      "https://example.test/r.git?%252525252574oken=synthetic-canary",
      "https://example.test/r.git?to%ZZken=synthetic-canary",
      "https:deploy:synthetic-canary@example.test/r.git",
      "https:/deploy:synthetic-canary@example.test/r.git",
      "https:\\deploy:synthetic-canary@example.test\\r.git",
      `https://deploy:${"x".repeat(600)}@example.test/r.git`,
    ]) {
      stored.scan.library = [{ ...template, source, value: source, reason: "" }];
      const candidates = await f.gw.api.listImportLibrary({ scanId });
      expect(candidates.items[0]?.status).toBe("unavailable");
      expect(candidates.items[0]?.detail).toBe("[redacted]");
      expect(await failure(f.gw.api.startImport({ scanId, library: [{ key: template.sourceKey }] }))).toContain(
        "Scan again",
      );
      const inserted = await f.sql((sql) => sql`SELECT 1 FROM import_library_items WHERE value = ${source}`);
      expect(inserted).toHaveLength(0);
    }

    const safe = "https://example.test/r.git?design=compact#authentication";
    stored.scan.library = [{ ...template, source: safe, value: safe, reason: "" }];
    const safeCandidates = await f.gw.api.listImportLibrary({ scanId });
    expect(safeCandidates.items[0]?.status).not.toBe("unavailable");
    expect(safeCandidates.items[0]?.detail).toBe(safe);
    const rows = await f.sql((sql) => sql`SELECT 1 FROM import_library_items WHERE value LIKE '%synthetic-canary%'`);
    expect(rows).toHaveLength(0);
  });
});
