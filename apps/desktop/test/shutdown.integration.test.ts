import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { tempDir } from "@canopy/testing";
import { DesktopRuntime } from "../src/runtime/runtime.ts";

const web = resolve(import.meta.dir, "../../web/build/index.js");
const directory = tempDir("canopy-desktop-shutdown-");

test.skipIf(!existsSync(web))("desktop stops the setup BFF promptly with an open browser connection", async () => {
  const runtime = new DesktopRuntime(directory, { bun: process.execPath, web, worker: "unused", gateway: "unused", postgres: "unused" },
    { databasePassword: "shutdown-test", serviceToken: "s".repeat(48), secretsKey: "shutdown-test" });
  try {
    const origin = await runtime.initialize(false);
    // Keep an incomplete browser request open. The BFF has no durable state to drain.
    const socket = await Bun.connect({ hostname: "127.0.0.1", port: Number(new URL(origin).port),
      socket: { data() {}, error() {} } });
    socket.write("GET /desktop HTTP/1.1\r\nHost: localhost\r\n");
    await Bun.sleep(100);
    try {
      const started = performance.now();
      await runtime.stop();
      const elapsed = performance.now() - started;
      console.info(`desktop BFF shutdown: ${Math.round(elapsed)}ms`);
      expect(elapsed).toBeLessThan(2_000);
    } finally { socket.end(); }
  } finally { await runtime.stop(); }
}, 20_000);
