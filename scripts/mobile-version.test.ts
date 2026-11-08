import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "canopy-mobile-version-"));
  directories.push(root);
  const mobile = join(root, "apps/mobile");
  mkdirSync(mobile, { recursive: true });
  mkdirSync(join(root, "scripts"));

  const script = join(root, "scripts/mobile-version.sh");

  copyFileSync(resolve("scripts/mobile-version.sh"), script);

  const app = {
    expo: { version: "1.0.0", extra: { eas: { projectId: "project" } }, runtimeVersion: { policy: "fingerprint" } },
  };

  writeFileSync(join(mobile, "app.json"), JSON.stringify(app));
  writeFileSync(join(mobile, "canopy-version.json"), JSON.stringify({ version: "0.0.0-dev" }));

  return {
    app,
    readApp: () => JSON.parse(readFileSync(join(mobile, "app.json"), "utf8")),
    readVersion: () => JSON.parse(readFileSync(join(mobile, "canopy-version.json"), "utf8")),
    run: (...args: string[]) => Bun.spawnSync(["bash", script, ...args], { cwd: root }),
  };
}

test.each(["0.2.0-nightly.105", "0.2.0-beta.3", "0.2.0"])(
  "injects the exact %s release and preserves native config",
  (version) => {
    const f = fixture();
    const result = f.run(`v${version}`);
    expect(result.exitCode).toBe(0);
    expect(f.readVersion()).toEqual({ version });
    expect(f.readApp()).toEqual({ expo: { ...f.app.expo, version: "0.2.0" } });
  },
);

test("a second release replaces the first and dev resets the JS version", () => {
  const f = fixture();
  expect(f.run("v0.2.0-nightly.105").exitCode).toBe(0);
  expect(f.run("v0.3.0-beta.1").exitCode).toBe(0);
  expect(f.readVersion()).toEqual({ version: "0.3.0-beta.1" });
  expect(f.readApp()).toEqual({ expo: { ...f.app.expo, version: "0.3.0" } });
  expect(f.run("dev").exitCode).toBe(0);
  expect(f.readVersion()).toEqual({ version: "0.0.0-dev" });
  expect(f.readApp()).toEqual({ expo: { ...f.app.expo, version: "0.0.0" } });
});

test("invalid input leaves both version files unchanged", () => {
  for (const args of [[], ["v0.2.0", "extra"], ["0.2.0"], ["v0.2.0-alpha.1"], ["v0.2.0-nightly.01"], ["v0.2.0\n"]]) {
    const f = fixture();
    expect(f.run(...args).exitCode).not.toBe(0);
    expect(f.readApp()).toEqual(f.app);
    expect(f.readVersion()).toEqual({ version: "0.0.0-dev" });
  }
});
