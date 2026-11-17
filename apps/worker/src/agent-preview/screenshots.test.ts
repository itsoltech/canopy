import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentTool } from "@canopy/contracts";
import { executable } from "../agent-tools/fixtures.test-support.ts";
import { toolEnvironment } from "../agent-tools/paths.ts";
import { eventually, previewFixture } from "./fixtures.test-support.ts";
import { PreviewRuntime } from "./runtime.ts";
import { screenshotPreview } from "./screenshots.ts";
import type { PreviewUpdate } from "./types.ts";

async function captureFixture() {
  const f = await previewFixture();
  const abort = new AbortController();
  const cache = process.platform === "darwin" ? join(f.dir, "Library", "Caches") : join(f.dir, "cache");
  const unavailableTemp = join(f.dir, "unavailable-temp");
  writeFileSync(unavailableTemp, "not a directory");

  const env = { ...toolEnvironment(f.env), XDG_CACHE_HOME: cache, LOCALAPPDATA: cache, TMPDIR: unavailableTemp };

  const runtime = new PreviewRuntime(
    {
      scope: f.scope,
      executable: f.path(AgentTool.DESKTOP),
      env,
      useDevice: (_signal, work) => work(),
      redact: (detail) => detail,
    },
    abort.signal,
  );

  const updates: PreviewUpdate[] = [];

  const backend = screenshotPreview({
    runtime,
    signal: abort.signal,
    active: () => true,
    emit: (v) => updates.push(v),
  });

  const path = () =>
    f
      .calls()
      .find((call) => call.command === "screenshot")
      ?.args.at(-1) ?? "";

  return { ...f, abort, cache, backend, updates, capturePath: path };
}

test("screenshot adapter captures with unavailable temp storage and only removes its private cache directory", async () => {
  const f = await captureFixture();
  const sibling = join(f.cache, "canopy", "agent-preview", "other-session");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "frame.png"), "another session");

  try {
    await f.backend.start();
    await eventually(() => f.updates.filter((v) => v.state === "frame").length >= 2);
    const path = f.capturePath();
    expect(path.startsWith(join(f.cache, "canopy", "agent-preview", "capture-"))).toBe(true);

    if (process.platform !== "win32") expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(existsSync(path)).toBe(false);
    expect(
      new Set(
        f
          .calls()
          .filter((v) => v.command === "screenshot")
          .map((v) => v.args.at(-1)),
      ).size,
    ).toBe(1);
    expect(f.updates.find((v) => v.state === "frame")?.mimeType).toBe("image/jpeg");
    expect(f.updates.some((v) => v.state === "error")).toBe(false);
  } finally {
    f.abort.abort();
    await f.backend.close();
  }

  expect(existsSync(dirname(f.capturePath()))).toBe(false);
  expect(readFileSync(join(sibling, "frame.png"), "utf8")).toBe("another session");
});

test.each(["command", "image"])("screenshot adapter removes a partial capture after %s failure", async (failure) => {
  const f = await captureFixture();
  executable(
    f.path(AgentTool.DESKTOP),
    `
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("screenshot")) {
  appendFileSync(${JSON.stringify(join(f.dir, "preview-log.jsonl"))}, JSON.stringify({args, command:"screenshot", event:"start"})+"\\n");
  writeFileSync(args.at(-1), "partial image");
  console.log(JSON.stringify(${JSON.stringify(
    failure === "command"
      ? { ok: false, error: "capture failed after writing" }
      : { ok: true, data: { width: 1200, height: 600 } },
  )}));
} else console.log(JSON.stringify({ok:true, data:[{id:"window-1", title:"Document", app_name:"Editor", is_focused:true, bounds:{x:0,y:0,width:1200,height:600}}]}));
`,
  );

  try {
    await f.backend.start();
    await eventually(() => f.updates.some((v) => v.state === "error"));
    expect(f.capturePath()).not.toBe("");
    expect(existsSync(f.capturePath())).toBe(false);
    expect(readdirSync(dirname(f.capturePath()))).toEqual([]);
    expect(f.updates.some((v) => v.state === "frame")).toBe(false);
  } finally {
    f.abort.abort();
    await f.backend.close();
  }

  expect(existsSync(dirname(f.capturePath()))).toBe(false);
});

test("catalog-only screenshot adapter allocates no capture storage", async () => {
  const f = await captureFixture();
  f.update({ windows: [] });

  try {
    await f.backend.start();
    expect(f.updates.some((v) => v.state === "ready")).toBe(true);
    expect(existsSync(f.cache)).toBe(false);
    expect(f.capturePath()).toBe("");
  } finally {
    f.abort.abort();
    await f.backend.close();
  }
});
