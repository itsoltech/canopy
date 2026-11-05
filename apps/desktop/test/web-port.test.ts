import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableWebPort } from "../src/runtime/web-port.ts";

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const run of cleanup.splice(0)) run();
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "canopy-web-port-"));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));

  return path;
}

function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
    cleanup.push(() => server.close());
  });
}

test("the web origin keeps its port across restarts, so device preferences survive", async () => {
  const dir = directory();
  const first = await stableWebPort(dir);

  expect(await stableWebPort(dir)).toBe(first);
  expect(await stableWebPort(dir)).toBe(first);
  expect(readFileSync(join(dir, "web-port"), "utf8").trim()).toBe(String(first));
});

test("a taken or invalid saved port is replaced and the new one is kept", async () => {
  const dir = directory();
  const first = await stableWebPort(dir);
  await occupy(first);

  const next = await stableWebPort(dir);
  expect(next).not.toBe(first);
  expect(readFileSync(join(dir, "web-port"), "utf8").trim()).toBe(String(next));

  for (const text of ["", "abc", "80", "70000", "123.4", "-1"]) {
    writeFileSync(join(dir, "web-port"), text);
    const port = await stableWebPort(dir);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(readFileSync(join(dir, "web-port"), "utf8").trim()).toBe(String(port));
  }
});
