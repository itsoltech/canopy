import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpdateRecord, stageBinaryUpdate } from "@canopy/updater";
import { packWeb } from "../../apps/gateway/src/web/archive.ts";
import { embeddedWebPlugin } from "../../scripts/build-binaries.ts";

/**
 * A binary gateway serves its embedded web inside its own process; one self-update replaces both, a web that
 * never becomes healthy rolls both back (docs/deploy.md, "Binaria (systemd)"). The web build is a small
 * adapter-node stand-in: the same `handler` export, health route and client layout.
 */
const VERSIONS = ["1.0.0", "2.0.0", "3.0.0"];
const BROKEN = "3.0.0";
const cleanups: (() => Promise<void>)[] = [];
let builds: string;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** adapter-node's `handler.js` stand-in: health, the protocol it saw, client files, and three kinds of failure. */
function webHandler(version: string): string {
  if (version === BROKEN) return 'throw new Error("broken web build");\n';

  return `import { createReadStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const client = join(dirname(fileURLToPath(import.meta.url)), "client");
export const handler = (req, res, next) => {
  if (req.url === "/api/health") return res.end(JSON.stringify({ status: "ok", version: ${JSON.stringify(version)} }));
  if (req.url === "/protocol") return res.end(String(req.headers[process.env.PROTOCOL_HEADER]));
  if (req.url === "/in-process") return res.end(String(process.env.CANOPY_WEB_IN_PROCESS));
  if (req.url === "/boom") throw new Error("boom in the web");
  if (req.url === "/async-boom") return Promise.reject(new Error("async failure in the web"));
  if (req.url === "/stray") {
    Promise.reject(new Error("stray rejection in the web"));
    return res.end("ok");
  }
  const file = join(client, req.url);
  if (req.url.startsWith("/_app/") && existsSync(file)) return createReadStream(file).pipe(res);
  next();
};
`;
}

async function compileFixture(version: string): Promise<void> {
  const web = join(builds, `web-${version}`);
  await mkdir(join(web, "client/_app/immutable"), { recursive: true });
  await writeFile(join(web, "handler.js"), webHandler(version));
  await writeFile(join(web, `client/_app/immutable/app-${version}.js`), `// ${version}\n`);
  const bytes = await packWeb(web, version);
  const file = join(builds, `web-${version}.zst`);
  await writeFile(file, bytes);
  const key = createHash("sha256").update(bytes).digest("hex").slice(0, 16);

  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures/embedded-web-binary.ts")],
    target: "bun",
    define: { "process.env.CANOPY_VERSION": JSON.stringify(version) },
    plugins: [embeddedWebPlugin({ file, key, version })],
    compile: { outfile: join(builds, version) },
  });

  if (!result.success) throw new AggregateError(result.logs, "Embedded web fixture compilation failed");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
}

/** Status of a GET with this raw Host header (fetch would set its own). */
function statusFor(port: number, host: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/health", headers: { ...headers, host } }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });

    req.on("error", fail);
    req.end();
  });
}

async function start(env: Record<string, string> = {}, port?: number) {
  const directory = await mkdtemp(join(tmpdir(), "canopy-embedded-web-"));
  const binaryPath = join(directory, "installed");
  await copyFile(join(builds, "1.0.0"), binaryPath);
  port ??= await freePort();
  const url = `http://127.0.0.1:${port}`;

  const proc = Bun.spawn([binaryPath], {
    env: {
      ...process.env,
      CANOPY_TEST_DIRECTORY: directory,
      CANOPY_SUPERVISED: "",
      CANOPY_UI_SERVICE_TOKEN: "embedded-web-fixture-token-0123456789",
      CANOPY_WEB_PORT: String(port),
      CANOPY_WEB_DIR: join(directory, "web"),
      ...env,
    },
    stdout: "ignore",
    stderr: "pipe",
  });

  const errors = new Response(proc.stderr).text();
  cleanups.push(async () => {
    if (proc.exitCode === null) proc.kill("SIGTERM");
    await proc.exited;
    await rm(directory, { recursive: true, force: true });
  });

  async function stage(version: string, previousVersion: string) {
    const bytes = await readFile(join(builds, version));
    await stageBinaryUpdate({
      binaryPath,
      currentVersion: previousVersion,
      version,
      commandId: `update-${version}`,
      asset: {
        app: "gateway",
        os: process.platform === "darwin" ? "darwin" : "linux",
        arch: process.arch === "arm64" ? "arm64" : "x64",
        name: "fixture",
        url: "https://release.fixture/binary",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      chunks: (async function* () {
        yield bytes;
      })(),
    });
    await writeFile(join(directory, "restart"), "");
  }

  async function events(): Promise<
    { type: string; version: string; pid: number; message?: string; state?: string; reason?: string }[]
  > {
    const text = await readFile(join(directory, "events.jsonl"), "utf8").catch(() => "");

    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /** Waits until the web on the configured port reports `version`. */
  async function serving(version: string) {
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
      const health = await fetch(`${url}/api/health`).then(
        (r) => r.json() as Promise<{ version: string }>,
        () => undefined,
      );

      if (health?.version === version) return;

      if (proc.exitCode !== null) break;
      await Bun.sleep(25);
    }

    throw new Error(`web ${version} not served: ${JSON.stringify(await events())} ${await errors}`);
  }

  /** The supervisor has handed over to `version` and that version's child is healthy again. */
  async function resident(version: string) {
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
      const all = await events();
      const handover = all.findIndex((e) => e.type === "supervisor" && e.version === version);

      if (handover >= 0 && all.slice(handover).some((e) => e.type === "healthy" && e.version === version)) return;
      await Bun.sleep(25);
    }

    throw new Error(`supervisor ${version} not resident: ${JSON.stringify(await events())} ${await errors}`);
  }

  async function until(predicate: (all: Awaited<ReturnType<typeof events>>) => boolean) {
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
      if (predicate(await events())) return;
      await Bun.sleep(25);
    }

    throw new Error(`fixture did not reach the expected state: ${JSON.stringify(await events())} ${await errors}`);
  }

  return { proc, url, port, binaryPath, stage, serving, resident, events, until };
}

describe.skipIf(process.platform === "win32")("binary gateway with embedded web", () => {
  beforeAll(async () => {
    builds = await mkdtemp(join(tmpdir(), "canopy-embedded-web-builds-"));

    for (const version of VERSIONS) await compileFixture(version);
  }, 90_000);
  afterAll(async () => {
    if (builds) await rm(builds, { recursive: true, force: true });
  });

  test("serves the web, swaps it with one self-update and rolls both back together", async () => {
    const f = await start();
    await f.serving("1.0.0");
    expect(await (await fetch(`${f.url}/protocol`)).text()).toBe("http");
    const proxied = await fetch(`${f.url}/protocol`, { headers: { "x-forwarded-proto": "https" } });
    expect(await proxied.text()).toBe("https");

    await f.stage("2.0.0", "1.0.0");
    await f.resident("2.0.0");
    await f.serving("2.0.0");
    // A tab still on 1.0.0 loads its hashed chunks from the retained release.
    const old = await fetch(`${f.url}/_app/immutable/app-1.0.0.js`);
    expect(old.status).toBe(200);
    expect(old.headers.get("cache-control")).toContain("immutable");
    expect(await old.text()).toBe("// 1.0.0\n");
    expect((await fetch(`${f.url}/_app/immutable/app-2.0.0.js`)).status).toBe(200);

    // The candidate's web never becomes healthy: the supervisor restores the previous binary, and with it the web.
    await f.stage(BROKEN, "2.0.0");
    const deadline = Date.now() + 20_000;

    while ((await readUpdateRecord(f.binaryPath))?.state !== "failed" && Date.now() < deadline) await Bun.sleep(25);
    const failed = await readUpdateRecord(f.binaryPath);
    expect(failed).toMatchObject({ state: "failed", version: BROKEN });
    // The update result names the web's own reason, not a generic startup timeout.
    expect(failed?.reason).toContain(`The web app of ${BROKEN} didn't start: broken web build`);
    await f.serving("2.0.0");
    const all = await f.events();
    expect(all.some((e) => e.type === "web-failed" && e.version === BROKEN)).toBe(true);
    // One supervisor process throughout (execve hand-over keeps the PID).
    expect(new Set(all.filter((e) => e.type === "supervisor").map((e) => e.pid))).toEqual(new Set([f.proc.pid]));

    f.proc.kill("SIGTERM");
    expect(await f.proc.exited).toBe(0);
    expect(
      await fetch(`${f.url}/api/health`).then(
        () => "open",
        () => "closed",
      ),
    ).toBe("closed");
  }, 60_000);

  test("a busy web port leaves the gateway running, says why and recovers when the port frees up", async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    const f = await start({}, port);
    await f.until(
      (all) =>
        all.some((e) => e.type === "healthy" && e.version === "1.0.0") &&
        all.some((e) => e.type === "web-state" && e.state === "failed" && e.reason?.includes(`Port ${port} is in use`)),
    );
    // Not an update: nothing to roll back, the gateway confirmed its startup.
    expect(await readUpdateRecord(f.binaryPath)).toBeUndefined();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await f.serving("1.0.0");
    await f.until((all) => all.some((e) => e.type === "web-state" && e.state === "running"));
  }, 30_000);

  test("answers only allowed Host names (DNS rebinding)", async () => {
    const f = await start({
      CANOPY_WEB_ALLOWED_HOSTS: "canopy.example.com, .corp.example",
      CANOPY_TEST_RUNTIME_HOSTS: "box.tail1.ts.net",
    });

    await f.serving("1.0.0");

    const allowed = [
      `127.0.0.1:${f.port}`,
      `localhost:${f.port}`,
      `[::1]:${f.port}`,
      "10.1.2.3",
      "canopy.example.com",
      "a.corp.example:443",
      "box.tail1.ts.net", // Tailscale Serve keeps the MagicDNS name as Host
    ];

    for (const host of allowed) expect([host, await statusFor(f.port, host)]).toEqual([host, 200]);

    for (const host of ["evil.example", "corp.example", "canopy.example.com.evil.example", "a b"])
      expect([host, await statusFor(f.port, host)]).toEqual([host, 421]);
    // Forwarded headers are script-settable on a rebound page: they never allow a host.
    expect(await statusFor(f.port, "evil.example", { "x-forwarded-host": "canopy.example.com" })).toBe(421);
  }, 30_000);

  test("serves the web in the gateway process and contains the web's failures", async () => {
    const f = await start();
    await f.serving("1.0.0");
    const gateway = (await f.events()).find((e) => e.type === "child")!.pid;
    // One process serves both: the gateway child has no web child of its own.
    expect((await Bun.$`ps -o pid= --ppid ${gateway}`.nothrow().text()).trim()).toBe("");
    expect(await (await fetch(`${f.url}/in-process`)).text()).toBe("1");

    expect((await fetch(`${f.url}/boom`)).status).toBe(500);
    expect((await fetch(`${f.url}/async-boom`)).status).toBe(500);
    expect((await fetch(`${f.url}/stray`)).status).toBe(200);
    await Bun.sleep(100);
    await f.serving("1.0.0");
    const all = await f.events();
    // The same gateway process answers: nothing crashed and nothing restarted it.
    expect(all.filter((e) => e.type === "child").map((e) => e.pid)).toEqual([gateway]);
    expect(all.some((e) => e.type === "log" && e.message?.includes("stray rejection in the web"))).toBe(true);
  }, 30_000);
});
