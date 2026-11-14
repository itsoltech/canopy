import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpdateRecord, stageBinaryUpdate } from "@canopy/updater";
import { packWeb } from "../../apps/gateway/src/web/archive.ts";
import { embeddedWebPlugin } from "../../scripts/build-binaries.ts";

/**
 * A binary gateway serves its embedded web from a child process of the same executable; one self-update
 * replaces both, a web that never becomes healthy rolls both back (docs/deploy.md, "Binaria (systemd)").
 * The web build is a small adapter-node stand-in: the same `server` export, health route and client layout.
 */
const VERSIONS = ["1.0.0", "2.0.0", "3.0.0"];
const BROKEN = "3.0.0";
const cleanups: (() => Promise<void>)[] = [];
let builds: string;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function webIndex(version: string): string {
  if (version === BROKEN) return 'throw new Error("broken web build");\n';

  return `import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const client = join(dirname(fileURLToPath(import.meta.url)), "client");
export const server = http.createServer((req, res) => {
  if (req.url === "/api/health") return res.end(JSON.stringify({ status: "ok", version: ${JSON.stringify(version)} }));
  if (req.url === "/protocol") return res.end(String(req.headers[process.env.PROTOCOL_HEADER]));
  const file = join(client, req.url);
  if (req.url.startsWith("/_app/") && existsSync(file)) return createReadStream(file).pipe(res);
  res.statusCode = 404;
  res.end();
});
server.listen(Number(process.env.PORT), process.env.HOST);
process.on("SIGTERM", () => server.close(() => process.emit("sveltekit:shutdown")));
`;
}

async function compileFixture(version: string): Promise<void> {
  const web = join(builds, `web-${version}`);
  await mkdir(join(web, "client/_app/immutable"), { recursive: true });
  await writeFile(join(web, "index.js"), webIndex(version));
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

async function start() {
  const directory = await mkdtemp(join(tmpdir(), "canopy-embedded-web-"));
  const binaryPath = join(directory, "installed");
  await copyFile(join(builds, "1.0.0"), binaryPath);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  const proc = Bun.spawn([binaryPath], {
    env: {
      ...process.env,
      CANOPY_TEST_DIRECTORY: directory,
      CANOPY_SUPERVISED: "",
      CANOPY_UI_SERVICE_TOKEN: "embedded-web-fixture-token-0123456789",
      CANOPY_WEB_PORT: String(port),
      CANOPY_WEB_DIR: join(directory, "web"),
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

  async function events(): Promise<{ type: string; version: string; pid: number; message?: string }[]> {
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

  return { proc, url, binaryPath, stage, serving, resident, events };
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
    expect(await readUpdateRecord(f.binaryPath)).toMatchObject({ state: "failed", version: BROKEN });
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
});
