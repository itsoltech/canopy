import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { ui, update } from "@canopy/contracts";
import { createGrpcClientTransport, startGrpcServer } from "@canopy/transport";
import { ReleaseSource, type ReleaseManifest } from "@canopy/updater";
import { GatewayReleaseMirror, UpdateCache } from "../../apps/gateway/src/updates/cache.ts";
import { GatewayUpdates } from "../../apps/gateway/src/updates/runtime.ts";
import { GatewayUpdateService } from "../../apps/gateway/src/updates/service.ts";
import { guard } from "../../apps/gateway/src/api/ui-errors.ts";
import { gatewayFailure } from "../../apps/web/src/lib/server/gateway-errors.ts";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "canopy-cache-test-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));

  return path;
}

async function runtimeFixture(unavailableSource = false) {
  const root = await directory();
  const blocked = join(root, "read-only");

  if (process.platform !== "win32" && process.getuid?.() !== 0) await mkdir(blocked, { mode: 0o500 });
  else await writeFile(blocked, "A regular file cannot contain a cache directory");
  const bytes = Buffer.from("verified worker update");

  const manifest: ReleaseManifest = {
    schema: 1,
    version: "2.0.0",
    channel: "stable",
    commit: "fixture",
    published_at: "2026-11-03T00:00:00Z",
    protocol: { worker_link: 1, update: 1 },
    assets: [
      {
        app: "worker",
        os: "linux",
        arch: "x64",
        name: "canopy-worker-linux-x64",
        url: "https://release.fixture/binary",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };

  const logs: string[] = [];
  const commands: update.UpdateCommand[] = [];

  const runtime = new GatewayUpdates({
    cacheDir: join(blocked, "releases"),
    version: "2.0.0",
    kind: "docker",
    log: (message) => logs.push(message),
    source: {
      baseUrl: "https://release.fixture",
      fetch: async (input) => {
        if (unavailableSource) throw new Error("upstream token=private-fixture-value");
        const path = new URL(String(input)).pathname;

        if (path === "/manifest") return Response.json(manifest);

        if (path === "/binary") return new Response(bytes);

        return Response.json({
          tag_name: "2.0.0",
          draft: false,
          prerelease: false,
          assets: [{ name: "manifest.json", browser_download_url: "https://release.fixture/manifest" }],
        });
      },
    },
    authenticate: async () => "worker",
    persistence: {
      admin: async () => true,
      channel: async () => undefined,
      setChannel: async () => {},
      workers: async () => [
        {
          id: "worker",
          name: "old",
          version: "1.0.0",
          os: "linux",
          arch: "x64",
          status: { installKind: "binary", state: "failed" },
        },
      ],
      hello: async () => {},
      report: async () => {},
      saveCommand: async (_id, command) => {
        commands.push(command);
      },
    },
  });

  const server = await startGrpcServer({
    routes: (router) => {
      runtime.service.routes(router);
      router.service(ui.GatewayService, { manageUpdates: (request) => guard(() => runtime.manage(request)) });
    },
  });

  cleanups.push(async () => {
    await server.close(50);
    runtime.close();
  });
  await runtime.start();
  const transport = createGrpcClientTransport({ baseUrl: server.url });

  return {
    runtime,
    logs,
    commands,
    bytes,
    api: createClient(ui.GatewayService, transport),
    worker: createClient(update.UpdateService, transport),
  };
}

test("worker update RPC and verified mirror work with an unwritable cache and warn once", async () => {
  const f = await runtimeFixture();
  await f.api.manageUpdates({ action: "worker", workerId: "worker" });
  await f.api.manageUpdates({ action: "worker", workerId: "worker" });
  expect(f.commands).toHaveLength(2);
  const chunks: Uint8Array[] = [];

  for await (const chunk of f.worker.fetchArtifact(
    { workerId: "worker", version: "2.0.0", os: "linux", arch: "x64" },
    { headers: { authorization: "Bearer fixture" } },
  ))
    chunks.push(chunk.data);
  expect(Buffer.concat(chunks)).toEqual(f.bytes);
  expect(f.logs.filter((message) => message.startsWith("Update cache"))).toHaveLength(1);
  const mirror = f.runtime.service.options.mirror;
  expect(await readFile(await mirror.artifact("linux", "x64"))).toEqual(f.bytes);
  expect(mirror.directory).not.toBe(f.runtime.options.cacheDir);
});

test("unwritable primary and temporary cache return FailedPrecondition through gRPC and HTTP mapping", async () => {
  const root = await directory();
  const blocked = join(root, "blocked");
  await writeFile(blocked, "not a directory");
  const cache = new UpdateCache(join(blocked, "releases"), () => {}, blocked);
  cleanups.push(() => cache.close());

  const service = new GatewayUpdateService({
    version: "2.0.0",
    authenticate: async () => "worker",
    hello: async () => {},
    command: async () => undefined,
    report: async () => {},
    mirror: new GatewayReleaseMirror(cache, "2.0.0", new ReleaseSource()),
  });

  const server = await startGrpcServer({ routes: service.routes });
  cleanups.push(async () => {
    service.close();
    await server.close(50);
  });
  const client = createClient(update.UpdateService, createGrpcClientTransport({ baseUrl: server.url }));

  const result = await (async () => {
    for await (const _chunk of client.fetchArtifact(
      { workerId: "worker", version: "2.0.0", os: "linux", arch: "x64" },
      { headers: { authorization: "Bearer fixture" } },
    )) {
      /* failure must precede data */
    }
  })().catch((cause: unknown) => cause);

  expect(result).toBeInstanceOf(ConnectError);
  expect((result as ConnectError).code).toBe(Code.FailedPrecondition);
  expect(gatewayFailure(result)).toEqual({
    status: 409,
    message: `Can't store update files: ${cache.directory} is not writable and temporary storage is unavailable`,
  });
});

test("release resolution failure reaches the BFF as a specific safe 409", async () => {
  const f = await runtimeFixture(true);
  const result = await f.api.manageUpdates({ action: "worker", workerId: "worker" }).catch((cause: unknown) => cause);
  expect(result).toBeInstanceOf(ConnectError);
  const failure = gatewayFailure(result);
  expect(failure.status).toBe(409);
  expect(failure.message).toContain("Can't prepare update release 2.0.0");
  expect(failure.message).not.toContain("private-fixture-value");
});

test("BFF distinguishes gateway internal errors, rejected requests and transport failures", () => {
  expect(gatewayFailure(new ConnectError("internal error", Code.Internal))).toEqual({
    status: 500,
    message: "internal error",
  });
  expect(gatewayFailure(new ConnectError("Invalid update target", Code.InvalidArgument))).toEqual({
    status: 400,
    message: "Invalid update target",
  });
  expect(gatewayFailure(new ConnectError("Worker offline", Code.Unavailable))).toEqual({
    status: 503,
    message: "Worker offline",
  });
  expect(
    gatewayFailure(
      new ConnectError("connect to private address", Code.Unavailable, undefined, undefined, new Error("ECONNREFUSED")),
    ),
  ).toEqual({ status: 502, message: "Could not reach the gateway. Check that it is running, then retry." });
  expect(gatewayFailure(new Error("local secret"))).toEqual({ status: 500, message: "The gateway request failed" });

  const failure = gatewayFailure(
    new ConnectError("Failed https://user:pass@private.fixture token=hidden Bearer hidden\nstack", Code.Internal),
  );

  expect(failure.message).toBe("Failed [address] token=[redacted] Bearer [redacted]");
});
