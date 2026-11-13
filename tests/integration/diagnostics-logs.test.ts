import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Logs, LogExporter, LogPullSource, logChecksum, registeredLogs } from "@canopy/logs";
import { tempDir } from "@canopy/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { wireHello } from "../../apps/gateway/src/computers/hello.ts";
import { startTestGateway, eventually, type TestGateway } from "./support/gateway.ts";
import { linkedComputers } from "./support/computers.ts";
import { join } from "node:path";
import { crc32 } from "node:zlib";

const directory = tempDir("canopy-diagnostics-log-integration-");

const code = (promise: Promise<object>) =>
  promise.then(
    () => 0,
    (error) => ConnectError.from(error).code,
  );

function archiveEntries(bytes: Buffer) {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  let cursor = bytes.readUInt32LE(end + 16);
  const entries = new Map<string, string>();

  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    const dataStart = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const data = bytes.subarray(dataStart, dataStart + size);
    expect(crc32(data)).toBe(bytes.readUInt32LE(cursor + 16));
    expect(name).not.toContain("..");
    expect(name).not.toStartWith("/");
    entries.set(name, data.toString());
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }

  return entries;
}

describe.skipIf(!dockerAvailable)("owner log collection over gRPC, worker link and a relay", () => {
  const gateways: TestGateway[] = [];
  const nodes: ReturnType<typeof linkedComputers>[] = [];
  let workerSource: LogPullSource;

  const ready = async (predicate: () => Promise<boolean> | boolean) =>
    expect(await eventually(async () => predicate(), Boolean, 45_000)).toBe(true);

  const id = (index: number) => nodes[index]!.hello().nodeId;

  async function collect(computers: string[], gateway = gateways[0]!) {
    const job = await gateway.api.collectDiagnosticsLogs({
      computerIds: computers,
      hours: 1,
      aliasHome: true,
      actionId: crypto.randomUUID(),
    });

    return eventually(
      () => gateway.api.getDiagnosticsLogsJob({ jobId: job.jobId }),
      (value) => value.status !== "collecting",
      20_000,
    );
  }

  async function download(job: ui.DiagnosticsLogsJob, gateway = gateways[0]!) {
    const chunks: Buffer[] = [];
    let sequence = 0;

    for await (const part of gateway.api.downloadDiagnosticsLogs({ jobId: job.jobId })) {
      expect(part.sequence).toBe(sequence++);

      if (part.end) break;
      expect(part.data.length).toBeLessThanOrEqual(32 * 1024);
      expect(part.checksum).toBe(logChecksum(part.data));
      chunks.push(Buffer.from(part.data));
    }

    const bytes = Buffer.concat(chunks);
    expect(BigInt(bytes.length)).toBe(job.bytes);

    for (const secret of ["private-token", "private-host", "/home/private", "INSERT INTO", "private prompt"])
      expect(bytes.toString()).not.toContain(secret);

    return archiveEntries(bytes);
  }

  beforeAll(async () => {
    const workerLogs = new Logs(join(directory, "worker"));
    workerLogs.write("worker", "worker connected private-token /home/private private-host.internal");
    workerSource = new LogPullSource(
      new LogExporter(registeredLogs(workerLogs.directory, ["worker"])),
      join(directory, "worker-spool"),
    );

    for (let index = 0; index < 3; index++) {
      const logs = new Logs(join(directory, `home-${index}`, "logs"));
      logs.write("gateway", "gateway listening private-token /home/private private-host.internal");
      logs.write("gateway", "STATEMENT: INSERT INTO secret VALUES ('private prompt')");

      const gateway = await startTestGateway({
        role: "desktop",
        diagnostics: true,
        diagnosticsLogDirectory: join(directory, `home-${index}`),
        logSources: registeredLogs(logs.directory, ["gateway"]),
        ...(index === 2 && {
          worker: { logs: workerSource, hello: { capabilities: ["diagnostics_v1", "diagnostics_logs_v1"] } },
        }),
      });

      gateways.push(gateway);

      const computer = linkedComputers({
        store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
        host: "127.0.0.1",
        heartbeatMs: 500,
        core: gateway.core,
        serve: remoteServe(uiHandlers(gateway.core), gateway.core),
      });

      nodes.push(computer);
      gateway.core.computers = computer;
      gateway.core.network = computer.options.network;
      await computer.start();
      await gateway.core.diagnostics.start();
    }

    for (const gateway of [gateways[0]!, gateways[2]!]) {
      const invitation = await gateways[1]!.api.createComputerPairing({});
      await gateway.api.linkComputer({ address: nodes[1]!.addresses[0]!, code: invitation.code });
    }

    await ready(() => nodes[0]!.reachable().includes(id(1)) && nodes[2]!.reachable().includes(id(1)));
    await gateways[1]!.api.manageComputer({ action: "share_onward", nodeId: id(0), shareOnwardNodeIds: [id(2)] });
    await ready(() => nodes[0]!.reachable().includes(id(2)) && nodes[2]!.relay.entries.has(id(0)));
  }, 90_000);

  afterAll(async () => {
    for (const node of nodes) await node.close();

    for (const gateway of gateways) await gateway.close();
    await workerSource?.close();
  }, 30_000);

  test("uses fresh aliases, partial manifests and redacted worker data without recursive collection", async () => {
    const job = await collect([id(0), id(1)]);
    expect(job.status).toBe("partial");
    expect(job.homes).toHaveLength(2);
    const entries = await download(job);
    expect(entries.has("Computer-1/gateway.log")).toBe(true);
    expect(entries.has("Computer-2/gateway.log")).toBe(true);
    expect(entries.has("Computer-3/gateway.log")).toBe(false);
    expect(entries.get("manifest.json")).not.toContain(id(0));
    expect(entries.get("Computer-1/manifest.json")).toContain('"uptimeSeconds"');
    expect(entries.get("manifest.json")).toContain('"omittedRecords":"1"');
  });

  test("read access cannot export logs; a separate durable home grant allows the owner and revoke invalidates download", async () => {
    const home = gateways[2]!;
    await home.api.setDiagnosticsGrant({ originComputerId: id(0), enabled: true });
    const denied = await collect([id(2)]);
    expect(denied.homes[0]?.status).toBe("not_permitted");
    await home.api.setDiagnosticsGrant({ originComputerId: id(0), enabled: true, permission: "diagnostics_logs" });
    const job = await collect([id(2)]);
    const entries = await download(job);
    expect(entries.get("Computer-1/Worker-1/worker.log")).toContain('"event":"process_started"');
    expect(home.worker.commands.some((command) => command.case === undefined)).toBe(false);
    await home.api.setDiagnosticsGrant({ originComputerId: id(0), enabled: false, permission: "diagnostics_logs" });
    await ready(
      async () => (await code(gateways[0]!.api.getDiagnosticsLogsJob({ jobId: job.jobId }))) === Code.NotFound,
    );
    const grants = await home.api.getDiagnosticsGrants({});
    expect(grants.grants.some((grant) => grant.permission === "diagnostics_read")).toBe(true);
    expect(grants.grants.some((grant) => grant.permission === "diagnostics_logs")).toBe(false);
  });

  test("owner auth, closed ranges and source registry prevent arbitrary file access", async () => {
    const api = createClient(ui.GatewayService, createGrpcTransport({ baseUrl: gateways[0]!.grpcUrl }));
    expect(await code(api.collectDiagnosticsLogs({}))).toBe(Code.Unauthenticated);
    expect(
      await code(
        gateways[0]!.api.collectDiagnosticsLogs({ actionId: crypto.randomUUID(), computerIds: [id(0)], hours: 72 }),
      ),
    ).toBe(Code.InvalidArgument);

    const watch = gateways[0]!.api
      .watchDiagnosticsLogSource({ session: "a".repeat(43), sources: ["../../private"] })
      [Symbol.asyncIterator]();

    expect(await code(watch.next())).toBe(Code.InvalidArgument);
    expect(await code(gateways[0]!.api.getDiagnosticsLogsJob({ jobId: crypto.randomUUID() }))).toBe(Code.NotFound);
    const hello = wireHello(nodes[0]!.hello());
    expect(hello.capabilities.length).toBeLessThanOrEqual(32);
    expect(hello.additionalCapabilities).toContain("diagnostics_logs_v1");
  });

  test("cancel closes the source and ZIP, invalidates download, and a retry is a new bounded action", async () => {
    const job = await gateways[0]!.api.collectDiagnosticsLogs({
      computerIds: [id(0)],
      hours: 1,
      actionId: crypto.randomUUID(),
    });

    const result = await gateways[0]!.api.cancelDiagnosticsLogs({ jobId: job.jobId });
    expect(result.status).toBe("cancelled");
    expect(gateways[0]!.core.diagnostics.logs.home.active.size).toBe(0);
    expect(await code(gateways[0]!.api.getDiagnosticsLogsJob({ jobId: job.jobId }))).toBe(Code.NotFound);
    expect(await collect([id(0)])).toHaveProperty("status", "partial");
  });
});
