import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { tempDir } from "@canopy/testing";
import { newestRelease, type DesktopRelease } from "../src/update-releases.ts";
import { mergeDesktopUpdates } from "../scripts/merge-update-metadata.ts";
const { machOFiles } = require("../scripts/macho.cjs") as { machOFiles: (directory: string) => string[] };

function release(tag: string, feed: string, prerelease = true): DesktopRelease {
  return { tag_name: tag, draft: false, prerelease, assets: [{ name: feed }, { name: "manifest.json" }] };
}

test("installed channels never promote, downgrade or select incomplete releases", () => {
  const releases = [
    release("v0.4.0", "latest-mac.yml", false),
    release("v0.5.0-nightly.9", "nightly-mac.yml"),
    release("v0.3.0-beta.1", "beta-mac.yml"),
    release("v0.3.0-beta.2", "beta-mac.yml"),
    { ...release("v0.3.0-beta.3", "beta-mac.yml"), draft: true },
    { ...release("v0.3.0-beta.4", "beta-mac.yml"), assets: [{ name: "beta-mac.yml" }] },
    release("not-a-version", "beta-mac.yml"),
  ];
  expect(newestRelease(releases, "0.3.0-beta.1", "beta", "beta-mac.yml")?.tag_name).toBe("v0.3.0-beta.2");
  expect(newestRelease(releases, "0.3.0-beta.2", "beta", "beta-mac.yml")).toBeUndefined();
  expect(newestRelease(releases, "0.4.0", "stable", "latest-mac.yml")).toBeUndefined();
  expect(newestRelease(releases, "0.4.0-nightly.1", "nightly", "nightly-mac.yml")?.tag_name).toBe("v0.5.0-nightly.9");
});

test("mac update metadata preserves both runner architectures and rejects mismatched content", async () => {
  const directory = tempDir("canopy-desktop-feeds-");
  const source = join(directory, "artifacts");
  for (const arch of ["arm64", "x64"]) {
    const artifact = join(source, `desktop-darwin-${arch}`);
    mkdirSync(artifact, { recursive: true });
    const name = `Canopy-Beta-0.3.0-beta.1-darwin-${arch}.zip`;
    const contents = Buffer.from(`fixture ${arch}`);
    const sha512 = createHash("sha512").update(contents).digest("base64");
    writeFileSync(join(artifact, name), contents);
    writeFileSync(join(artifact, "beta-mac.yml"), JSON.stringify({ version: "0.3.0-beta.1", files: [{ url: name, sha512 }], path: name, sha512 }));
  }
  const output = join(directory, "assets");
  await mergeDesktopUpdates(source, output, "beta", "0.3.0-beta.1");
  const feed = load(readFileSync(join(output, "beta-mac.yml"), "utf8")) as { files: { url: string }[] };
  expect(feed.files.map((file) => file.url).sort()).toEqual([
    "Canopy-Beta-0.3.0-beta.1-darwin-arm64.zip", "Canopy-Beta-0.3.0-beta.1-darwin-x64.zip",
  ]);
  await expect(mergeDesktopUpdates(source, join(directory, "wrong-channel"), "nightly", "0.3.0-beta.1")).rejects.toThrow("Unexpected");
  const arm = join(source, "desktop-darwin-arm64", "Canopy-Beta-0.3.0-beta.1-darwin-arm64.zip");
  writeFileSync(arm, "corrupt download");
  await expect(mergeDesktopUpdates(source, join(directory, "corrupt"), "beta", "0.3.0-beta.1")).rejects.toThrow("checksum");
});

test("signing discovers extensionless JIT sidecars and nested native libraries without following aliases", () => {
  const directory = tempDir("canopy-desktop-macho-");
  mkdirSync(join(directory, "postgres/lib"), { recursive: true });
  mkdirSync(join(directory, "node_modules/native"), { recursive: true });
  const names = ["canopy-worker", "postgres/lib/libpq.dylib", "node_modules/native/sharp.node"];
  for (const name of names) writeFileSync(join(directory, name), Buffer.from("cffaedfe00000000", "hex"), { mode: 0o644 });
  writeFileSync(join(directory, "postgres/init.sql"), "select 1;");
  writeFileSync(join(directory, "icon.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  symlinkSync("postgres/lib/libpq.dylib", join(directory, "libpq-alias"));
  expect(machOFiles(directory).sort()).toEqual(names.map((name) => join(directory, name)).sort());
});
