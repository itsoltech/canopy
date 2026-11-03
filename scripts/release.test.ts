/** Behavioral dry-runs of the real config against a throwaway local clone; no GitHub or app services. */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveVersion } from "./version.ts";
import { releaseManifest } from "./release-manifest.ts";

const root = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];
afterEach(() => { for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "oa-release-unit-"));
  temporaryDirectories.push(dir);
  const remote = join(dir, "origin.git"), cwd = join(dir, "checkout");
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "pipe" });
  execFileSync("git", ["clone", remote, cwd], { stdio: "pipe" });
  git("remote", "set-url", "origin", pathToFileURL(remote).href);
  git("config", "user.name", "Release fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "core.hooksPath", "/dev/null");
  git("config", "tag.gpgSign", "false");
  git("config", "tag.forceSignAnnotated", "false");
  git("config", "commit.gpgSign", "false");
  mkdirSync(join(cwd, "scripts"));
  copyFileSync(join(root, "release.config.mjs"), join(cwd, "canopy.config.mjs"));
  copyFileSync(join(root, "scripts/release-analyzer.mjs"), join(cwd, "scripts/release-analyzer.mjs"));
  writeFileSync(join(cwd, "release.config.mjs"), 'import config from "./canopy.config.mjs"; export default { ...config, plugins: config.plugins.filter((plugin) => !(Array.isArray(plugin) && plugin[0] === "@semantic-release/github")) };\n');
  writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
  symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
  git("add", ".");
  git("commit", "-m", "chore: bootstrap fixture");
  git("tag", "v0.1.0");
  git("branch", "next");
  git("branch", "dev");
  git("push", "origin", "main", "next", "dev", "--tags");
  async function run(dry = true): Promise<string> {
    const result = Bun.spawn(["bunx", "--no-install", "semantic-release", ...(dry ? ["--dry-run"] : []), "--no-ci"], {
      cwd, env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_ACTIONS: "", GITHUB_REF: "", GITHUB_SHA: "", CI: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
    const output = stdout + stderr;
    if (code !== 0) throw new Error(output);
    return output;
  }
  return { git, dryRun: () => run(), publishLocally: () => run(false), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test("bootstrap branches produce no release, then feat produces stable, beta and nightly 0.2.0", async () => {
  const repo = fixture();
  try {
    for (const [branch, version] of [["main", "0.2.0"], ["next", "0.2.0-beta.1"], ["dev", "0.2.0-nightly.1"]]) {
      repo.git("checkout", branch!);
      expect(await repo.dryRun()).toContain("no new version is released");
      repo.git("commit", "--allow-empty", "-m", "feat: add release fixture feature");
      repo.git("push", "origin", branch!);
      expect(await repo.dryRun()).toContain(`Published release ${version} on`);
    }
  } finally { repo.cleanup(); }
}, 60_000);
test("BREAKING CHANGE bumps minor while 0.x, and major after 1.0.0", async () => {
  const repo = fixture();
  try {
    repo.git("commit", "--allow-empty", "-m", "feat: change contract\n\nBREAKING CHANGE: require the new contract");
    repo.git("push", "origin", "main");
    expect(await repo.dryRun()).toContain("Published release 0.2.0 on");
    repo.git("tag", "v1.0.0");
    repo.git("commit", "--allow-empty", "-m", "feat: replace contract\n\nBREAKING CHANGE: remove the old contract");
    repo.git("push", "origin", "main", "--tags");
    expect(await repo.dryRun()).toContain("Published release 2.0.0 on");
  } finally { repo.cleanup(); }
}, 60_000);
test("release versions assign Docker aliases exclusively to their channel", () => {
  const commit = "abc123456789";
  expect(resolveVersion({ commit, tag: "v0.1.0" }).dockerTags).toEqual(["v0.1.0", "v0.1", "v0", "latest", "stable"]);
  expect(resolveVersion({ commit, tag: "v0.2.0-beta.1" }).dockerTags).toEqual(["v0.2.0-beta.1", "beta"]);
  expect(resolveVersion({ commit, tag: "v0.2.0-nightly.1" }).dockerTags).toEqual(["v0.2.0-nightly.1", "nightly"]);
  expect(resolveVersion({ commit }).dockerTags).toEqual([]);
});
test("manifest preserves the exact version/channel and rejects contradictory release metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oa-release-manifest-unit-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "canopy-worker-linux-x64"), "fixture binary");
  const env = { GITHUB_SHA: "abc123456789", CANOPY_VERSION: "0.2.0-beta.1", CANOPY_RELEASE_TAG: "v0.2.0-beta.1", CANOPY_CHANNEL: "beta" };
  const manifest = await releaseManifest(directory, env);
  expect(manifest.version).toBe("0.2.0-beta.1");
  expect(manifest.channel).toBe("beta");
  expect(manifest.assets[0]?.url).toContain("/v0.2.0-beta.1/canopy-worker-linux-x64");
  await expect(releaseManifest(directory, { ...env, CANOPY_CHANNEL: "stable" })).rejects.toThrow("must match");
});
test("fast-forward promotions retain the base version, and docs-only changes produce no release", async () => {
  const repo = fixture();
  try {
    repo.git("checkout", "dev");
    repo.git("commit", "--allow-empty", "-m", "feat: add a promoted feature");
    repo.git("push", "origin", "dev");
    expect(await repo.publishLocally()).toContain("Published release 0.2.0-nightly.1 on nightly");
    repo.git("checkout", "next");
    repo.git("merge", "--ff-only", "dev");
    repo.git("push", "origin", "next");
    expect(await repo.publishLocally()).toContain("Published release 0.2.0-beta.1 on beta");
    repo.git("checkout", "main");
    repo.git("merge", "--ff-only", "next");
    repo.git("push", "origin", "main");
    expect(await repo.publishLocally()).toContain("Published release 0.2.0 on default");
    repo.git("commit", "--allow-empty", "-m", "docs: explain promotion");
    repo.git("push", "origin", "main");
    expect(await repo.dryRun()).toContain("no new version is released");
  } finally { repo.cleanup(); }
}, 60_000);
