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
  LOG_SOURCES,
  verifiedLogChunks,
  logChecksum,
} from "../src/index.ts";

const directory = tempDir("canopy-log-security-");
const signal = () => AbortSignal.timeout(10_000);

async function verifyText(text: string, source: (typeof LOG_SOURCES)[number]) {
  const input = Buffer.from(text);

  const chunks = async function* () {
    for (let index = 0; index < input.length; index += 7) yield input.subarray(index, index + 7);
  };

  const output: Uint8Array[] = [];
  let omitted = 0;

  for await (const chunk of verifiedLogChunks(chunks(), source, () => omitted++)) output.push(chunk);

  return { text: Buffer.concat(output).toString(), omitted };
}

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
      `${at} worker events not stored: worker 11111111-1111-4111-8111-111111111111 thread 22222222-2222-4222-8222-222222222222 reason retry_pending`,
      `${at} worker events dropped: worker 11111111-1111-4111-8111-111111111111 thread 22222222-2222-4222-8222-222222222222 count 3 reason deleted_thread`,
      `${at} worker events quarantined: worker 11111111-1111-4111-8111-111111111111 thread 22222222-2222-4222-8222-222222222222 count 1 reason archived_thread`,
      `${at} worker events deferred: count 1 reason legacy_ingest_drain; update the gateway to resume delivery`,
      `${at} events of thread 22222222-2222-4222-8222-222222222222 not stored (kept on worker 11111111-1111-4111-8111-111111111111): PgConnection: Query failed: thread is archived or deleted /home/private token-secret`,
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
    expect(result!.coverage.records).toBe(11);
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
      "22222222",
      "PgConnection",
      "token-secret",
      "journal-private",
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain('"event":"process_started"');
    expect(text).toContain('"event":"link_changed"');

    for (const event of ["not_stored", "dropped", "quarantined", "deferred"])
      expect(text).toContain(`"event":"worker_events_${event}"`);
    const verified: Uint8Array[] = [];
    let omitted = 0;

    const chunks = async function* () {
      yield Buffer.from(text);
    };

    for await (const chunk of verifiedLogChunks(chunks(), "gateway", () => omitted++)) verified.push(chunk);
    expect(omitted).toBe(0);
    expect(Buffer.concat(verified).toString()).toBe(text);
    expect(result!.coverage.redactedRecords).toBe(11);
  });

  test("bot diagnostics retain only closed dimensions from source to coordinator across split chunks", async () => {
    const root = join(directory, "bot-dimensions");
    await mkdir(root);
    const at = new Date().toISOString();
    const turnRecords = [];

    for (const failureSource of ["provider", "harness", "platform"])
      for (const failureClass of [
        "auth_required",
        "cli_missing",
        "model_unavailable",
        "usage_limit",
        "network",
        "stream_cut_off",
        "process_exit",
        "configuration",
        "connection_changed",
        "tool_approval",
        "provider_unavailable",
        "internal",
      ])
        turnRecords.push({
          message: `bots: turn failed source ${failureSource} class ${failureClass}`,
          event: "bot_turn_failed",
          failureSource,
          failureClass,
        });
    const toolRecords = [];

    for (const toolSource of ["platform", "mcp", "unknown"])
      for (const operation of ["start_thread", "send_message", "send_bot_message", "other"])
        for (const outcome of ["completed", "failed", "discarded", "changes_requested", "expired", "interrupted"])
          toolRecords.push({
            message: `bots: tool finished source ${toolSource} operation ${operation} outcome ${outcome}`,
            event: "bot_tool_finished",
            toolSource,
            operation,
            outcome,
          });

    for (const source of ["gateway", "worker"] as const) {
      const records = source === "gateway" ? [...turnRecords, ...toolRecords] : turnRecords;
      const file = join(root, `${source}.log`);
      await writeFile(file, records.map(({ message }) => `${at} ${message}\n`).join(""));
      const exporter = new LogExporter([{ source, file, rotationVerified: true }]);

      const [result] = await exporter.export(
        join(root, `${source}-spool`),
        { hours: 1, legacy: false, bytes: LOG_LIMITS.source },
        signal(),
      );

      const text = await readFile(result!.file, "utf8");

      const expected = records
        .toReversed()
        .map(
          ({ message: _message, event, ...dimensions }) =>
            JSON.stringify({ at: Date.parse(at), source, event, legacy: false, ...dimensions }) + "\n",
        )
        .join("");

      expect(text).toBe(expected);
      expect(result!.coverage.records).toBe(records.length);
      expect(await verifyText(text, source)).toEqual({ text: expected, omitted: 0 });
    }
  });

  test("bot source projection omits malformed dimensions, trailing secrets and records from the wrong runtime", async () => {
    const root = join(directory, "bot-source-security");
    await mkdir(root);
    const at = new Date().toISOString();
    const turn = "bots: turn failed source provider class network";
    const tool = "bots: tool finished source platform operation send_message outcome failed";
    const legacy = "bots: turn failed (private-bot private-token /home/private private-host.internal thread-private)";

    const fixed = [
      { message: "bots: queue tick failed", event: "bot_queue_tick_failed", source: "gateway" },
      { message: "bots: queue wake failed", event: "bot_queue_wake_failed", source: "gateway" },
      {
        message: "bots: turn could not be settled; lease recovery will resume it",
        event: "bot_turn_settlement_failed",
        source: "gateway",
      },
      { message: "bots: harness journal failed", event: "bot_harness_journal_failed", source: "worker" },
    ];

    const hostile = [
      turn.replace("provider", "private-token"),
      turn.replace("network", "private-token"),
      tool.replace("platform", "private-token"),
      tool.replace("send_message", "private-token"),
      tool.replace("failed", "private-token"),
      `${turn} private-token`,
      `${tool} private-token`,
      `${legacy} private-token`,
      "bots: turn failed source provider class network operation send_message",
      "bots: tool finished source platform operation send_message",
      `prefix ${turn}`,
      ...fixed.map(({ message }) => `${message} private-token`),
    ];

    for (const source of LOG_SOURCES) {
      const file = join(root, `${source}.log`);
      const lines = [turn, tool, legacy, ...fixed.map(({ message }) => message), ...hostile];
      await writeFile(file, lines.map((message) => `${at} ${message}\n`).join(""));
      const exporter = new LogExporter([{ source, file, rotationVerified: true }]);

      const [result] = await exporter.export(
        join(root, `${source}-spool`),
        { hours: 1, legacy: false, bytes: LOG_LIMITS.source },
        signal(),
      );

      const text = await readFile(result!.file, "utf8");
      const count = source === "gateway" ? 6 : source === "worker" ? 3 : 0;
      expect(result!.coverage.records).toBe(count);
      expect(result!.coverage.omittedRecords).toBe(lines.length - count);
      expect(await verifyText(text, source)).toEqual({ text, omitted: 0 });
      expect(text).not.toMatch(/private|\/home|thread-/);

      if (count) {
        expect(text).toContain(
          JSON.stringify({ at: Date.parse(at), source, event: "bot_turn_failed", legacy: false }) + "\n",
        );

        for (const record of fixed) if (record.source === source) expect(text).toContain(`"event":"${record.event}"`);
      }
    }
  });

  test("coordinator rejects hostile bot dimensions, extra fields, wrong event structure and source across split chunks", async () => {
    const turn =
      '{"at":123,"source":"gateway","event":"bot_turn_failed","legacy":false,"failureSource":"provider","failureClass":"network"}\n';

    const tool =
      '{"at":123,"source":"gateway","event":"bot_tool_finished","legacy":false,"toolSource":"platform","operation":"send_message","outcome":"failed"}\n';

    const legacy = '{"at":123,"source":"gateway","event":"bot_turn_failed","legacy":false}\n';

    const hostile = [
      turn.replace('"provider"', '"private-token"'),
      turn.replace('"network"', '"private-token"'),
      tool.replace('"platform"', '"private-token"'),
      tool.replace('"send_message"', '"private-token"'),
      tool.replace('"failed"', '"private-token"'),
      turn.replace('"network"', '"network private-token"'),
      turn.replace("}\n", ',"message":"private-token"}\n'),
      turn.replace("}\n", ',"failureClass":"private-token"}\n'),
      turn.replace("}\n", ',"operation":"send_message"}\n'),
      turn.replace(',"failureClass":"network"', ""),
      turn.replace(',"failureSource":"provider"', ""),
      turn.replace("bot_turn_failed", "bot_tool_finished"),
      tool.replace("bot_tool_finished", "bot_turn_failed"),
      tool.replace('"gateway"', '"worker"'),
      turn.replace('"gateway"', '"web"'),
      tool.replace(',"toolSource":"platform","operation":"send_message","outcome":"failed"', ""),
      legacy.replace("bot_turn_failed", "bot_queue_unknown"),
      legacy.replace("bot_turn_failed", "bot_harness_journal_failed"),
      legacy.replace('"gateway"', '"worker"').replace("bot_turn_failed", "bot_queue_tick_failed"),
      turn.replace("}\n", "}private-token\n"),
    ];

    const safe = turn + tool + legacy;
    expect(await verifyText(safe + hostile.join("") + safe, "gateway")).toEqual({
      text: safe + safe,
      omitted: hostile.length,
    });
    expect(await verifyText(turn + tool + legacy, "worker")).toEqual({ text: "", omitted: 3 });
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
