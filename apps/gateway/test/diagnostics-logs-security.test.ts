import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { createHandlerContext } from "@connectrpc/connect";
import { computerLink, ui } from "@canopy/contracts";
import { LogZip, logChecksum } from "@canopy/logs";
import { tempDir } from "@canopy/testing";
import { join } from "node:path";
import { LogArchive } from "../src/diagnostics/log-archive.ts";
import { requireLocalLogSource } from "../src/api/ui-diagnostics-logs.ts";
import { mobileIdentity } from "../src/core/mobile-devices.ts";
import { wireHello } from "../src/computers/hello.ts";
import { REMOTE_THREAD_PANEL, THREAD_RANGES } from "@canopy/domain/computers";

test("paired phones, desktop renderers and linked callers cannot impersonate a private log source", () => {
  const context = createHandlerContext({
    method: ui.GatewayService.method.watchDiagnosticsLogSource,
    service: ui.GatewayService,
    protocolName: "connect",
    requestMethod: "POST",
    url: "",
  });

  expect(() => requireLocalLogSource(context)).not.toThrow();

  for (const clientKind of ["mobile", "desktop"]) {
    context.values.set(mobileIdentity, { deviceId: crypto.randomUUID(), userId: crypto.randomUUID(), clientKind });
    expect(() => requireLocalLogSource(context)).toThrow("private local service channel");
  }

  const remote = createHandlerContext({
    method: ui.GatewayService.method.replyDiagnosticsLogSource,
    service: ui.GatewayService,
    protocolName: "canopy.link",
    requestMethod: "POST",
    url: "",
  });

  expect(() => requireLocalLogSource(remote)).toThrow("private local service channel");
});

test("capability extensions preserve old peer handshake limits without dropping modern features", () => {
  const legacy = Array.from({ length: 32 }, (_, index) => `capability_${index}`);

  const hello = wireHello(
    create(computerLink.NodeHelloSchema, {
      capabilities: [...legacy, THREAD_RANGES, REMOTE_THREAD_PANEL, "diagnostics_logs_v1"],
    }),
  );

  expect(hello.capabilities).toEqual(legacy);
  expect(hello.capabilities.length).toBeLessThanOrEqual(32);
  expect(hello.additionalCapabilities).toEqual([THREAD_RANGES, REMOTE_THREAD_PANEL, "diagnostics_logs_v1"]);
  expect(wireHello(hello)).toEqual(hello);
});

test("archive counts only verified bytes and marks interrupted entries truncated without copying errors", async () => {
  const directory = tempDir("canopy-log-archive-security-");
  const zip = await LogZip.create(join(directory, "logs.zip"));
  const archive = new LogArchive(zip);
  const home = create(ui.DiagnosticsLogsHomeSchema, { alias: "Computer-1" });
  const safe = '{"at":123,"source":"gateway","event":"process_started","legacy":false}\n';
  const input = Buffer.from(safe + '{"parameters":"private-secret"}\n');

  const stream = async function* () {
    yield create(ui.DiagnosticsLogPartSchema, { sequence: 0, environment: {} });
    yield create(ui.DiagnosticsLogPartSchema, {
      sequence: 1,
      coverage: { source: "gateway", status: "done", bytes: BigInt(input.length) },
    });
    yield create(ui.DiagnosticsLogPartSchema, { sequence: 2, data: input, checksum: logChecksum(input) });
    yield create(ui.DiagnosticsLogPartSchema, {
      sequence: 3,
      coverage: { source: "worker", worker: 1, status: "done" },
    });
    throw new Error("private driver error with parameters");
  };

  try {
    await expect(archive.home("Computer-1", stream(), home, 4096, AbortSignal.timeout(5000))).rejects.toThrow(
      "private driver error",
    );
    expect(home.bytes).toBe(BigInt(Buffer.byteLength(safe)));
    expect(home.sources[0]?.bytes).toBe(home.bytes);
    expect(home.sources[0]?.omittedRecords).toBe(1n);
    expect(home.sources[0]?.status).toBe("omitted");
    expect(home.sources[1]?.status).toBe("truncated");
    await zip.finish();
  } finally {
    await zip.close();
  }

  const bytes = await Bun.file(join(directory, "logs.zip")).text();
  expect(bytes).not.toContain("private-secret");
  expect(bytes).not.toContain("private driver error");
});
