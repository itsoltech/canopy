import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { eventually } from "./support/gateway.ts";
import { importFixture } from "./support/imports.ts";

describe.skipIf(!dockerAvailable)("CLI import: generated library names", () => {
  const dir = tempDir("canopy-import-names-");
  let f: Awaited<ReturnType<typeof importFixture>>;

  const finished = (runId: string) =>
    eventually(
      () => f.gw.api.getImportRun({ runId, items: true }),
      (run) => !["running", "paused"].includes(run.status),
      20_000,
    );

  const library = async () => {
    const { scanId } = await f.gw.api.scanImport({ workerId: f.workerId });

    return { scanId, ...(await f.gw.api.listImportLibrary({ scanId })) };
  };

  beforeAll(async () => {
    f = await importFixture(dir, { clis: ["claude", "codex"], library: true });
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  test("long worker names import distinct documents without splitting graphemes or renaming previous imports", async () => {
    const names = ["w".repeat(189) + "a", "w".repeat(189) + "b", "e\u0301👩🏽‍💻🇵🇱".repeat(10)];
    const runs: string[] = [];
    let previous: { id: string; name: string }[] = [];

    for (const name of names) {
      await f.gw.api.renameWorker({ workerId: f.workerId, name });
      expect((await f.gw.api.getAgentEnvironment({})).documents.map(({ id, name }) => ({ id, name }))).toEqual(
        previous,
      );

      // A new source revision permits another import while earlier successful imports remain live.
      for (const [cli, file] of [
        ["claude", "CLAUDE.md"],
        ["codex", "AGENTS.md"],
      ])
        appendFileSync(join(f.home, `.${cli}`, file!), `\nRevision ${runs.length}\n`);
      const scan = await library();
      const instructions = scan.items.filter((item) => item.kind === "instruction" && item.status === "new");
      expect(instructions).toHaveLength(2);

      const done = await finished(
        (await f.gw.api.startImport({ scanId: scan.scanId, library: instructions.map((item) => ({ key: item.key })) }))
          .id,
      );

      runs.push(done.id);
      expect(done.status).toBe("completed");
      expect(done.library.map((item) => item.status)).toEqual(["done", "done"]);
      const documents = (await f.gw.api.getAgentEnvironment({})).documents;
      expect(documents).toHaveLength(previous.length + 2);
      expect(new Set(documents.map((document) => document.name)).size).toBe(documents.length);

      for (const item of instructions) {
        const document = documents.find((document) => document.name === item.name)!;
        expect(document).toBeDefined();
        expect(document.name.length).toBeLessThanOrEqual(120);
        const prefix = item.agentCli === "claude" ? "Claude Code CLAUDE.md (" : "Codex AGENTS.md (";
        expect(document.name.startsWith(prefix)).toBe(true);
        expect(document.name).toMatch(/…-[a-f0-9]{10}\)$/);
        const shortened = document.name.slice(prefix.length).split("…-")[0]!;
        const boundaries = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(name)];
        expect(boundaries.some(({ index }) => index === shortened.length)).toBe(true);
        expect(name.startsWith(shortened)).toBe(true);
        expect(document.selector?.workerIds).toEqual([f.workerId]);
      }

      previous = documents.map(({ id, name }) => ({ id, name }));
      const again = await library();
      expect(
        again.items
          .filter((item) => item.kind === "instruction" && item.agentCli !== "grok")
          .map((item) => item.status),
      ).toEqual(["imported", "imported"]);
    }

    for (const runId of runs.toReversed()) {
      const undone = await f.gw.api.undoImportRun({ runId });
      expect(undone.library.every((item) => item.status === "undone")).toBe(true);
    }

    expect((await f.gw.api.getAgentEnvironment({})).documents).toHaveLength(0);
  }, 60_000);

  test("Keep both reserves room for its counter and Replace and Undo preserve the original name", async () => {
    await f.gw.api.renameWorker({ workerId: f.workerId, name: "x".repeat(190) });
    const scan = await library();
    const item = scan.items.find((item) => item.kind === "instruction" && item.agentCli === "claude")!;

    const first = await finished(
      (await f.gw.api.startImport({ scanId: scan.scanId, library: [{ key: item.key }] })).id,
    );

    const original = (await f.gw.api.getAgentEnvironment({})).documents[0]!;
    appendFileSync(join(f.home, ".claude", "CLAUDE.md"), "\nChanged instructions\n");
    let conflict = await library();
    const changed = conflict.items.find((candidate) => candidate.key === item.key)!;
    expect(changed.status).toBe("conflict");
    const copies: string[] = [];

    for (let n = 2; n <= 3; n++) {
      const done = await finished(
        (await f.gw.api.startImport({ scanId: conflict.scanId, library: [{ key: item.key, action: "keep_both" }] })).id,
      );

      expect(done.library[0]?.status).toBe("done");
      const documents = (await f.gw.api.getAgentEnvironment({})).documents;
      expect(new Set(documents.map((document) => document.name)).size).toBe(documents.length);
      expect(documents.every((document) => document.name.length <= 120)).toBe(true);
      expect(documents.some((document) => document.name.endsWith(`) (${n})`))).toBe(true);
      copies.push(done.id);

      // A new source revision exercises the next occupied counter while both earlier documents remain.
      if (n === 2) {
        appendFileSync(join(f.home, ".claude", "CLAUDE.md"), "\nAnother revision\n");
        conflict = await library();
      }
    }

    for (const runId of copies.toReversed()) await f.gw.api.undoImportRun({ runId });
    const replace = await library();

    const replaced = await finished(
      (await f.gw.api.startImport({ scanId: replace.scanId, library: [{ key: item.key, action: "replace" }] })).id,
    );

    expect(replaced.library[0]?.status).toBe("done");
    expect((await f.gw.api.getAgentEnvironment({})).documents[0]).toMatchObject({
      id: original.id,
      name: original.name,
    });
    await f.gw.api.undoImportRun({ runId: replaced.id });
    expect((await f.gw.api.getAgentEnvironment({})).documents[0]).toMatchObject({
      id: original.id,
      name: original.name,
      fragments: original.fragments,
    });
    await f.gw.api.undoImportRun({ runId: first.id });
  });

  test("long connected account names retain graphemes and remain distinct for the owner", async () => {
    const names = ["server-" + "a".repeat(100) + "one", "server-" + "a".repeat(100) + "two", "👩🏽‍💻e\u0301".repeat(12)];
    writeFileSync(
      join(f.home, ".claude.json"),
      JSON.stringify({
        mcpServers: Object.fromEntries(
          names.map((name, n) => [name, { type: "http", url: `https://mcp${n}.example.test` }]),
        ),
      }),
    );
    const scan = await library();
    const connectors = scan.items.filter((item) => item.kind === "connector" && item.agentCli === "claude");
    expect(connectors).toHaveLength(3);

    const run = await finished(
      (await f.gw.api.startImport({ scanId: scan.scanId, library: connectors.map((item) => ({ key: item.key })) })).id,
    );

    expect(run.library.map((item) => item.status)).toEqual(["done", "done", "done"]);
    const { accounts } = await f.gw.api.listConnectors({});
    expect(accounts).toHaveLength(3);
    expect(new Set(accounts.map((account) => account.name)).size).toBe(3);
    expect(accounts.every((account) => account.name.length <= 80)).toBe(true);
    expect(accounts.map((account) => account.name).sort()).toEqual(connectors.map((item) => item.name).sort());
    await f.gw.api.undoImportRun({ runId: run.id });
    expect((await f.gw.api.listConnectors({})).accounts).toHaveLength(0);
  });

  test("Retry imports a legacy failed item whose stored document label exceeds the limit", async () => {
    const workerName = "legacy-" + "z".repeat(183);
    await f.gw.api.renameWorker({ workerId: f.workerId, name: workerName });
    appendFileSync(join(f.home, ".codex", "AGENTS.md"), "\nLegacy retry revision\n");
    const scan = await library();
    const item = scan.items.find((item) => item.kind === "instruction" && item.agentCli === "codex")!;
    const save = f.gw.core.environment.save.bind(f.gw.core.environment);
    let runId = "";
    f.gw.core.environment.save = () => Promise.reject(new Error("Synthetic document store failure"));

    try {
      const failed = await finished(
        (await f.gw.api.startImport({ scanId: scan.scanId, library: [{ key: item.key }] })).id,
      );

      runId = failed.id;
      expect(failed.library[0]?.status).toBe("failed");
    } finally {
      f.gw.core.environment.save = save;
    }

    const legacy = `Codex AGENTS.md (${workerName})`;
    await f.sql((sql) => sql`UPDATE import_library_items SET label = ${legacy} WHERE run_id = ${runId}::uuid`);
    await f.gw.api.resumeImportRun({ runId });
    const retried = await finished(runId);
    expect(retried.library[0]?.status).toBe("done");
    const documents = (await f.gw.api.getAgentEnvironment({})).documents;
    const document = documents.find((document) => document.harness === "codex")!;
    expect(document.name).toBe(item.name);
    expect(document.name.length).toBeLessThanOrEqual(120);
    expect(document.name.startsWith("Codex AGENTS.md (")).toBe(true);
    expect(document.name).toMatch(/…-[a-f0-9]{10}\)$/);
    expect((await f.gw.api.undoImportRun({ runId })).library[0]?.status).toBe("undone");
  });
});
