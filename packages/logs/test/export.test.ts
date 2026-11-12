import { describe, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile, readdir, utimes, stat } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import {
  Logs,
  LogExporter,
  LogPullSource,
  LogZip,
  logJsonChunks,
  LOG_LIMITS,
  verifiedLogChunks,
  logChecksum,
} from "../src/index.ts";

const directory = tempDir("canopy-log-security-");
const signal = () => AbortSignal.timeout(10_000);

describe("source log security and bounded exports", () => {
  test("rotation never exceeds the file budget and continuous writers prune expired rotations", async () => {
    const logs = new Logs(join(directory, "rotation"));
    const file = join(logs.directory, "gateway.log");
    await writeFile(file, Buffer.alloc(LOG_LIMITS.rotation - 20, 65));
    logs.write("gateway", "gateway listening");
    expect((await stat(file)).size).toBeLessThanOrEqual(LOG_LIMITS.line);
    expect((await stat(`${file}.1`)).size).toBe(LOG_LIMITS.rotation - 20);
    const old = new Date(Date.now() - LOG_LIMITS.retentionMs - 1000);
    await utimes(`${file}.1`, old, old);
    logs.prune();
    expect(await readdir(logs.directory)).toEqual(["gateway.log"]);
  });
  test("writer buffers split secrets and UTF-8, bounds lines, separates stdout/stderr, and rejects traversal", async () => {
    const logs = new Logs(join(directory, "writer"));
    logs.protect("a-private-token-123456");
    const out = logs.stream("gateway");
    out("worker connected a-private-");
    out("token-123456 héllo\n");
    out(Buffer.alloc(LOG_LIMITS.line + 10, 65));
    out("secret discarded\nworker connected again\n");
    logs.write("../outside", "not allowed");
    const text = await readFile(join(logs.directory, "gateway.log"), "utf8");
    expect(text).not.toContain("a-private-token");
    expect(text).toContain("[REDACTED] héllo");
    expect(text).toContain("worker connected again");
    expect(text).not.toContain("secret discarded");
    expect(await readdir(logs.directory)).toEqual(["gateway.log"]);
  });

  test("redacts complete records before chunking; SQL, structured payloads, hosts and paths never leave a source", async () => {
    const root = join(directory, "redaction");
    await mkdir(root);
    const at = new Date().toISOString();

    const records = [
      `${at} worker connected Bearer top-secret /home/private/workspace private-host.internal 192.168.1.6`,
      `${at} gateway 0.0.0-dev listening on http://private-host.internal:21595`,
      `${at} worker 11111111-1111-4111-8111-111111111111 connected`,
      `${at} worker 11111111-1111-4111-8111-111111111111 disconnected`,
      `${at} worker 11111111-1111-4111-8111-111111111111 (Canopy 0.0.0-dev), gateway http://private-host.internal, data /home/private/workspace, journal journal-private`,
      `${at} {"event":"unknown","prompt":"private prompt","token":"top-secret"}`,
      `${at} ERROR: write failed`,
      `${at} STATEMENT: INSERT secret VALUES('private prompt')`,
      `${at} DETAIL: parameters: ['top-secret']`,
      `${at} cause: query-private`,
      `${at} ${"x".repeat(LOG_LIMITS.line + 500)}`,
      `${at} worker connected second`,
    ];

    await writeFile(join(root, "gateway.log"), records.join("\n") + "\nunfinished Bearer top-secret");
    const exporter = new LogExporter([{ source: "gateway", file: join(root, "gateway.log"), rotationVerified: true }]);

    const [result] = await exporter.export(
      join(root, "spool"),
      { hours: 1, legacy: false, bytes: LOG_LIMITS.source },
      signal(),
    );

    const text = await readFile(result!.file, "utf8");
    expect(result!.coverage.records).toBe(6);
    expect(result!.coverage.omittedRecords).toBeGreaterThanOrEqual(6);

    for (const secret of [
      "top-secret",
      "/home",
      "private-host",
      "192.168",
      "private prompt",
      "INSERT",
      "STATEMENT",
      "parameters",
      "query-private",
      "0.0.0-dev",
      "11111111",
      "journal-private",
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain('"event":"process_started"');
    expect(text).toContain('"event":"link_changed"');
    expect(result!.coverage.redactedRecords).toBe(6);
  });

  test("selects newest complete records within the post-redaction cap, with explicit range and legacy coverage", async () => {
    const root = join(directory, "tail");
    await mkdir(root);
    const now = new Date().toISOString();
    await writeFile(
      join(root, "worker.log"),
      [
        `${new Date(Date.now() - 7_200_000).toISOString()} worker connected old`,
        "worker connected untimed",
        ...Array.from({ length: 30 }, () => `${now} worker connected current`),
      ].join("\n") + "\n",
    );
    const exporter = new LogExporter([{ source: "worker", file: join(root, "worker.log"), rotationVerified: true }]);
    const [result] = await exporter.export(join(root, "spool"), { hours: 1, legacy: false, bytes: 300 }, signal());
    expect(result!.coverage.bytes).toBeLessThanOrEqual(300);
    expect(result!.coverage.status).toBe("truncated");
    expect(result!.coverage.omittedRecords).toBeGreaterThan(20);
    expect(result!.coverage.firstAtMs).toBe(Date.parse(now));
    expect(result!.coverage.legacy).toBe(false);
    const [legacy] = await exporter.export(join(root, "legacy"), { hours: 6, legacy: true, bytes: 10_000 }, signal());
    expect(legacy!.coverage.records).toBe(32);
    expect(legacy!.coverage.legacy).toBe(true);
  });

  test("source symlinks and unknown structured records fail closed", async () => {
    const root = join(directory, "symlink");
    await mkdir(root);
    await writeFile(join(root, "private"), `${new Date().toISOString()} worker connected secret\n`);
    await symlink(join(root, "private"), join(root, "gateway.log"));
    const exporter = new LogExporter([{ source: "gateway", file: join(root, "gateway.log"), rotationVerified: false }]);
    const [result] = await exporter.export(join(root, "spool"), { hours: 1, legacy: false, bytes: 1000 }, signal());
    expect(result!.coverage.status).toBe("omitted");
    expect(result!.coverage.bytes).toBe(0);
    expect(await readFile(result!.file, "utf8")).toBe("");
  });

  test("pulls are ordered and checksummed, cancellation closes the spool, and a second exporter cannot grow a queue", async () => {
    const root = join(directory, "pull");
    const logs = new Logs(root);
    logs.write("worker", "worker connected");

    const source = new LogPullSource(
      new LogExporter([{ source: "worker", file: join(root, "worker.log"), rotationVerified: true }]),
      join(root, "spool"),
    );

    const transferId = crypto.randomUUID();

    const part = await source.receive(
      create(ui.DiagnosticsLogSourceCommandSchema, {
        transferId,
        begin: { actionId: transferId, hours: 1, budgetBytes: 1000 },
      }),
    );

    expect(part.sequence).toBe(0);
    expect(part.coverage?.records).toBe(1n);
    const data = await source.receive(create(ui.DiagnosticsLogSourceCommandSchema, { transferId }));
    expect(data.sequence).toBe(1);
    expect(data.checksum).toBe(logChecksum(data.data));
    await source.receive(create(ui.DiagnosticsLogSourceCommandSchema, { transferId, cancel: true }));
    expect(await readdir(join(root, "spool"))).toEqual([]);
    await expect(source.receive(create(ui.DiagnosticsLogSourceCommandSchema, { transferId }))).rejects.toThrow(
      "unavailable",
    );
    await source.close();
  });

  test("coordinator rejects arbitrary source bytes, even with a valid transport checksum or split secrets", async () => {
    const safe = '{"at":123,"source":"worker","event":"process_started","legacy":false}\n';
    const input = Buffer.from(safe + '{"token":"private-secret","path":"/home/private"}\n' + safe);
    let omitted = 0;

    const chunks = async function* () {
      for (let index = 0; index < input.length; index += 7) yield input.subarray(index, index + 7);
    };

    const result: Buffer[] = [];

    for await (const bytes of verifiedLogChunks(chunks(), "worker", () => omitted++)) result.push(bytes);
    expect(Buffer.concat(result).toString()).toBe(safe + safe);
    expect(omitted).toBe(1);
  });

  test("ZIP rejects traversal, duplicates and large chunks; a failed source still leaves a valid partial archive", async () => {
    const path = join(directory, "archive.zip");
    const zip = await LogZip.create(path);
    await expect(zip.add("../private", logJsonChunks({}), signal())).rejects.toThrow("Invalid");

    const broken = async function* () {
      yield Buffer.from("safe\n");
      throw new Error("private error parameters");
    };

    await expect(zip.add("Computer-1/gateway.log", broken(), signal())).rejects.toThrow("private error");
    await zip.add("manifest.json", logJsonChunks({ partial: true }), signal());
    await expect(zip.add("manifest.json", logJsonChunks({}), signal())).rejects.toThrow("Duplicate");
    await zip.finish();
    await zip.close();
    const bytes = await readFile(path);
    expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50);
    expect(bytes.readUInt16LE(bytes.length - 12)).toBe(2);
    const central = bytes.readUInt32LE(bytes.length - 6);
    expect(bytes.readUInt32LE(central)).toBe(0x02014b50);
    expect(bytes.toString()).not.toContain("private error parameters");
  });
});
