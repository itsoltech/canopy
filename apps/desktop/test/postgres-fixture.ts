import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { isString } from "../src/runtime/config.ts";

/** Real native Postgres in a fake npm registry: never touches the internet. */
export function postgresArchive(directory: string) {
  const target = `${process.platform}-${process.arch}`;
  const packageName = `@embedded-postgres/${target.replace("win32", "windows")}`;
  const source = resolve(dirname(realpathSync(require.resolve(packageName))), "..");
  mkdirSync(directory, { recursive: true });
  cpSync(source, join(directory, "package"), { recursive: true, dereference: false, verbatimSymlinks: true });
  const tar = join(directory, "postgres.tgz");
  const result = Bun.spawnSync(["tar", "-czf", tar, "-C", directory, "package"], { stderr: "pipe" });

  if (result.exitCode !== 0) throw new Error(`PostgreSQL fixture tar failed: ${result.stderr}`);
  const bytes = readFileSync(tar);
  const version = (JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { version: string }).version;

  const pin = {
    packageName,
    version,
    major: Number(version.split(".")[0]),
    target,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };

  const manifest = join(directory, "postgres.json");
  writeFileSync(manifest, JSON.stringify(pin));

  return { bytes, pin, manifest };
}

export async function postgresRegistry(bytes: Buffer, interruptFirst = false) {
  const ranges: (string | undefined)[] = [];
  let unavailable = false;

  const server = createServer((request, response) => {
    // Only the package download counts: local tools probe new loopback ports with `GET /`.
    if (!request.url?.endsWith(".tgz")) {
      response.writeHead(404);
      response.end();

      return;
    }

    ranges.push(request.headers.range);

    if (unavailable) {
      response.writeHead(503);
      response.end();

      return;
    }

    if (interruptFirst && ranges.length === 1) {
      response.writeHead(200, { "Content-Length": bytes.length });
      response.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      setTimeout(() => response.destroy(), 50);

      return;
    }

    const offset = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1] ?? 0);
    response.writeHead(offset ? 206 : 200, {
      "Content-Length": bytes.length - offset,
      ...(offset && { "Content-Range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}` }),
    });
    response.end(bytes.subarray(offset));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || isString(address)) throw new Error("No test registry port");

  return {
    registry: `http://127.0.0.1:${address.port}/`,
    ranges,
    offline: (value: boolean) => {
      unavailable = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
