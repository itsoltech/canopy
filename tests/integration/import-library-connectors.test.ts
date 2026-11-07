import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { Effect } from "effect";
import { URL_BOUNDARIES } from "../../apps/worker/src/import/fixtures/url-boundaries.ts";
import { libraryReceipt, type LibraryRow } from "../../apps/gateway/src/imports/library-store.ts";
import { fakeConnector } from "./support/connector.ts";
import { eventually, failure } from "./support/gateway.ts";
import { importFixture } from "./support/imports.ts";

/**
 * CLI import, stack B stage 8 (docs/import.md, "Serwery MCP"): MCP servers of the CLIs as connector accounts. A
 * header's value leaves the worker only for a slot the owner chose, with a one-time confirmation, and is kept only in
 * the account's encrypted credentials.
 */
describe.skipIf(!dockerAvailable)("CLI import: MCP servers as connected accounts", () => {
  const dir = tempDir("canopy-import-connectors-");
  const fake = fakeConnector();
  let f: Awaited<ReturnType<typeof importFixture>>;

  const finished = (runId: string) =>
    eventually(
      () => f.gw.api.getImportRun({ runId, items: true }),
      (r) => !["running", "paused"].includes(r.status),
      20_000,
    );

  const library = async () => {
    const { scanId } = await f.gw.api.scanImport({ workerId: f.workerId });
    const response = await f.gw.api.listImportLibrary({ scanId });
    const of = (name: string) => response.items.find((i) => i.kind === "connector" && i.name === name)!;

    return { scanId, response, of };
  };

  const accounts = async () => (await f.gw.api.listConnectors({})).accounts;

  /** Every row of every table of the gateway's database, as text, that contains `text`. */
  const stored = async (text: string) => {
    const tables = await f.sql(
      (sql) => sql<{ name: string }>`SELECT table_name AS name FROM information_schema.tables
                                      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );

    const found: string[] = [];

    for (const { name } of tables) {
      const rows = await f.sql(
        (sql) => sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql(name)} t WHERE t::text LIKE ${`%${text}%`}`,
      );

      if (rows[0]!.n > 0) found.push(name);
    }

    return found;
  };

  beforeAll(async () => {
    f = await importFixture(dir, { clis: ["claude"], library: true });
    writeFileSync(
      join(f.home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          ...Object.fromEntries(URL_BOUNDARIES.map((url, index) => [`boundary-${index}`, { type: "http", url }])),
          "fixture-live": { type: "http", url: fake.url, headers: { Authorization: `Bearer ${fake.secret}` } },
          "fixture-env": {
            type: "http",
            url: `${fake.url}?unused`,
            headers: { Authorization: "Bearer ${FIXTURE_TOKEN}" },
          },
          "fixture-local": { type: "stdio", command: "fixture-mcp" },
          "fixture-userinfo": { type: "http", url: "https://deploy:CANARYpass@mcp.example.test/mcp" },
          "fixture-tokenq": { type: "http", url: "https://mcp.example.test/mcp?api_key=CANARYkey" },
          "fixture-encoded": { type: "http", url: "https://mcp.example.test/mcp?%74oken=CANARYencoded" },
          "fixture-double": { type: "http", url: "https://mcp.example.test/mcp?%2574oken=CANARYdouble" },
          "fixture-deep": { type: "http", url: "https://mcp.example.test/mcp?%252525252574oken=CANARYdeep" },
          "fixture-ambiguous": { type: "http", url: "https://mcp.example.test/mcp?to%ZZken=CANARYambiguous" },
          "fixture-space": { type: "http", url: "https://deploy:boundary CANARYspace@mcp.example.test/mcp" },
          "fixture-quote": { type: "http", url: 'https://deploy:boundary"CANARYquote@mcp.example.test/mcp' },
          "fixture-docs": { type: "http", url: "https://mcp.example.test/mcp#authentication" },
          "fixture-single": { type: "http", url: "https:/deploy:CANARYsingle@mcp.example.test/mcp" },
          "fixture-noslash": { type: "http", url: "https:deploy:CANARYnoslash@mcp.example.test/mcp" },
          "fixture-backslash": { type: "http", url: "https:\\deploy:CANARYback@mcp.example.test\\mcp" },
          "fixture-long": { type: "http", url: `https://deploy:${"x".repeat(600)}CANARYlong@mcp.example.test/mcp` },
          "fixture-invalid": { type: "http", url: "https://deploy:CANARYinvalid@[broken/mcp" },
          "fixture-fragment": { type: "http", url: "https://mcp.example.test/mcp#%61uth=CANARYfragment" },
          "fixture-double-fragment": { type: "http", url: "https://mcp.example.test/mcp#%2574oken=CANARYfragment" },
        },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await f?.close();
    fake.close();
  });

  test("lists servers with their header slots and never a value; stdio and URLs with secrets stay out", async () => {
    const { response, of } = await library();

    expect(of("fixture-live")).toMatchObject({ status: "new", transport: "http", suggested: true });
    expect(of("fixture-live").slots.map((s) => [s.name, s.kind])).toEqual([["Authorization", "literal"]]);
    expect(of("fixture-env").reason).toContain("may hold a secret");
    expect(of("fixture-local").reason).toContain("Runs a command on this computer");
    expect(JSON.stringify(response.items.map((i) => [i.detail, i.slots.map((s) => s.variable)]))).not.toContain(
      fake.secret,
    );
    expect(JSON.stringify(response.items.map((i) => i.warnings))).not.toContain(fake.secret);
    // URLs with credentials: listed, masked, never importable.
    expect(of("fixture-userinfo")).toMatchObject({ status: "unavailable" });
    expect(of("fixture-tokenq")).toMatchObject({ status: "unavailable" });

    for (const name of [
      "encoded",
      "double",
      "deep",
      "ambiguous",
      "space",
      "quote",
      "single",
      "noslash",
      "backslash",
      "long",
      "invalid",
      "fragment",
      "double-fragment",
    ])
      expect(of(`fixture-${name}`)).toMatchObject({ status: "unavailable" });
    expect(of("fixture-docs")).toMatchObject({ status: "new", detail: "https://mcp.example.test/mcp#authentication" });
    expect(toJsonString(ui.ListImportLibraryResponseSchema, response)).not.toContain("CANARY");

    for (const [index, url] of URL_BOUNDARIES.entries()) {
      const item = of(`boundary-${index}`);
      expect(item.status).toBe("unavailable");
      expect(item.detail).not.toBe(url);
    }
  });

  test("without the owner's choice no value is read: the account has no header and no access", async () => {
    const { scanId, of } = await library();
    const run = await finished((await f.gw.api.startImport({ scanId, library: [{ key: of("fixture-live").key }] })).id);
    const account = (await accounts()).find((a) => a.name === "fixture-live")!;

    expect(run.library[0]).toMatchObject({ status: "done" });
    expect(run.library[0]?.detail).toContain("Enter Authorization there");
    expect(account).toMatchObject({ connectorType: "custom", url: fake.url, allWorkers: false, allBots: false });
    expect(account.headerNames).toEqual([]);
    expect(account.workerIds).toEqual([]);
    await f.gw.api.undoImportRun({ runId: run.id });
    expect((await accounts()).some((a) => a.name === "fixture-live")).toBe(false);
  });

  test("a chosen secret goes from the worker into the encrypted account only, and the account works", async () => {
    const { scanId, of } = await library();
    // Only headers with a value in the file can be chosen.
    expect(
      await failure(f.gw.api.startImport({ scanId, library: [{ key: of("fixture-live").key, secrets: ["X-Other"] }] })),
    ).toContain("that have a value in the CLI file");

    const run = await finished(
      (await f.gw.api.startImport({ scanId, library: [{ key: of("fixture-live").key, secrets: ["Authorization"] }] }))
        .id,
    );

    expect(run.library[0]?.status).toBe("done");
    const account = (await accounts()).find((a) => a.name === "fixture-live")!;
    expect(account.headerNames).toEqual(["Authorization"]);
    // The fake server accepts only this bearer token: the account lists its tools.
    expect((await f.gw.api.testConnector({ accountId: account.id })).tools.length).toBeGreaterThan(0);

    // Nowhere in the database as plain text (credentials are sealed), and the confirmation is spent.
    expect(await stored(fake.secret)).toEqual([]);
    // The search does find what is stored as text (the account's name).
    expect(await stored("fixture-live")).toContain("connector_accounts");
    expect(
      (
        await f.sql(
          (sql) =>
            sql<{
              c: string | null;
            }>`SELECT confirmation AS c FROM import_library_items WHERE run_id = ${run.id}::uuid`,
        )
      )[0]?.c,
    ).toBeNull();

    // The worker kept nothing of it either (its journal is the only thing it writes).
    for (const name of readdirSync(f.data).filter((n) => n.startsWith("journal")))
      expect(readFileSync(join(f.data, name)).includes(Buffer.from(fake.secret))).toBe(false);

    // Undo keeps an account the owner changed since (access given).
    await f.gw.api.setConnectorAccess({ accountId: account.id, allWorkers: true, expectedRevision: account.revision });
    const undone = await f.gw.api.undoImportRun({ runId: run.id });
    expect(undone.library[0]?.status).toBe("kept");
    expect((await accounts()).some((a) => a.id === account.id)).toBe(true);
  });

  test("Undo removes an account only at the revision the import left, checked in the deleting transaction", async () => {
    // Accounts the tests above kept would make the server "same in Canopy".
    for (const kept of (await accounts()).filter((a) => a.name.startsWith("fixture-live")))
      await f.gw.core.connectors.remove(kept.id);
    const { scanId, of } = await library();
    const run = await finished((await f.gw.api.startImport({ scanId, library: [{ key: of("fixture-live").key }] })).id);
    const account = (await accounts()).find((a) => a.name === "fixture-live")!;

    // The owner renames it while an Undo that read the old revision is on its way.
    await f.gw.api.saveConnectorAccount({
      id: account.id,
      name: "fixture-live renamed",
      connectorType: "custom",
      expectedRevision: account.revision,
    });
    expect(await f.gw.core.connectors.remove(account.id, { expectedRevision: account.revision })).toBe("changed");
    expect((await accounts()).some((a) => a.id === account.id)).toBe(true);

    const [row] = await f.sql(
      (sql) => sql<LibraryRow>`SELECT * FROM import_library_items WHERE run_id = ${run.id}::uuid`,
    );

    // A failure after the kept receipt rolls it back with the revision-checking transaction.
    expect(
      await f.gw.core.connectors
        .remove(account.id, {
          expectedRevision: account.revision,
          changedReceipt: (sql) =>
            Effect.gen(function* () {
              yield* libraryReceipt(row!, "kept")(sql);

              return yield* Effect.die(new Error("Synthetic receipt interruption"));
            }),
        })
        .then(
          () => "committed",
          () => "rolled back",
        ),
    ).toBe("rolled back");

    const [unchanged] = await f.sql(
      (sql) => sql<{ status: string }>`SELECT status FROM import_library_items WHERE id = ${row!.id}::uuid`,
    );

    expect(unchanged?.status).toBe("done");

    const undone = await f.gw.api.undoImportRun({ runId: run.id });
    expect(undone.library[0]?.status).toBe("kept");
    expect((await accounts()).some((a) => a.id === account.id)).toBe(true);
  });

  test("gateway validation refuses canonical credential URLs before storing an MCP plan", async () => {
    const { scanId } = await library();
    const storedScan = f.gw.core.imports.stored(scanId);
    const template = storedScan.scan.library.find((i) => i.kind === "connector")!;

    for (const detail of [
      ...URL_BOUNDARIES,
      "https://mcp.example.test/mcp?%74oken=CANARYplan",
      "https://mcp.example.test/mcp?%2574oken=CANARYplan",
      "https://mcp.example.test/mcp?%252525252574oken=CANARYplan",
      "https://mcp.example.test/mcp?to%ZZken=CANARYplan",
      "https://mcp.example.test/mcp#%2574oken=CANARYplan",
      "https://deploy:boundary CANARYplan@mcp.example.test/mcp",
      'https://deploy:boundary"CANARYplan@mcp.example.test/mcp',
      "https:deploy:CANARYplan@mcp.example.test/mcp",
      "https:/deploy:CANARYplan@mcp.example.test/mcp",
      "https:\\deploy:CANARYplan@mcp.example.test\\mcp",
      `https://deploy:${"x".repeat(600)}CANARYplan@mcp.example.test/mcp`,
      "https://mcp.example.test/mcp#%61uth=CANARYplan",
    ]) {
      storedScan.scan.library = [{ ...template, detail, reason: "" }];
      const response = await f.gw.api.listImportLibrary({ scanId });
      expect(response.items[0]?.status).toBe("unavailable");
      expect(response.items[0]?.detail).toBe("[redacted]");
      expect(await failure(f.gw.api.startImport({ scanId, library: [{ key: template.sourceKey }] }))).toContain(
        "Scan again",
      );
      const inserted = await f.sql((sql) => sql`SELECT 1 FROM import_library_items WHERE value = ${detail}`);
      expect(inserted).toHaveLength(0);
    }

    const rows = await f.sql((sql) => sql`SELECT 1 FROM import_library_items WHERE value LIKE '%CANARYplan%'`);
    expect(rows).toHaveLength(0);
  });

  test("unavailable MCP metadata masks nested header names and environment variables", async () => {
    const secret = "SLOT_CANARY_CREDENTIAL_0042";
    writeFileSync(join(f.home, ".claude", ".credentials.json"), JSON.stringify({ token: secret }));
    writeFileSync(
      join(f.home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          nested: {
            type: "http",
            url: `${fake.url}?unused`,
            headers: { [secret]: "fixture-value", Authorization: `Bearer ${"${"}${secret}}` },
          },
        },
      }),
    );
    const { response, of } = await library();
    expect(of("nested").status).toBe("unavailable");
    expect(of("nested").slots.some((s) => s.name === "[redacted]")).toBe(true);
    expect(of("nested").slots.some((s) => s.variable === "[redacted]")).toBe(true);
    expect(toJsonString(ui.ListImportLibraryResponseSchema, response).includes(secret)).toBe(false);
  });
});
