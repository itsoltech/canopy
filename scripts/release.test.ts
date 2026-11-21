/** Behavioral dry-runs of the real config against a throwaway local clone; no GitHub or app services. */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveVersion } from "./version.ts";
import { releaseManifest, writeReleaseFiles } from "./release-manifest.ts";
import { mergeDesktopUpdates } from "../apps/desktop/scripts/merge-update-metadata.ts";
import { newestRelease } from "../apps/desktop/src/update-releases.ts";

const root = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "canopy-release-unit-"));
  temporaryDirectories.push(dir);

  const remote = join(dir, "origin.git"),
    cwd = join(dir, "checkout");

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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
  copyFileSync(join(root, "scripts/release-expected-version.mjs"), join(cwd, "scripts/release-expected-version.mjs"));
  copyFileSync(join(root, "scripts/semantic-release.mjs"), join(cwd, "scripts/semantic-release.mjs"));

  for (const file of [
    "release-body.mjs",
    "release-draft.mjs",
    "release-recovery.mjs",
    "release-version-policy.mjs",
    "generate-release-notes.mjs",
  ])
    copyFileSync(join(root, "scripts", file), join(cwd, "scripts", file));
  writeFileSync(
    join(cwd, "pinned-release.mjs"),
    `
import { releasePinned } from "./scripts/semantic-release.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const records = existsSync("releases.json") ? JSON.parse(readFileSync("releases.json", "utf8")) : [];
const draft = existsSync("draft.json") ? JSON.parse(readFileSync("draft.json", "utf8")) : undefined;

await releasePinned({
  dryRun: process.argv.includes("--dry-run"),
  listReleases: () => [
    { tag_name: "v0.1.0", draft: false, prerelease: false },
    ...records,
    ...(draft && !records.some((release) => release.tag_name === draft.tag_name) ? [draft] : []),
  ],
  createDraft: (body) => writeFileSync("draft.json", JSON.stringify(body)),
});
`,
  );
  writeFileSync(
    join(cwd, "release.config.mjs"),
    'import config from "./canopy.config.mjs"; export default { ...config, plugins: config.plugins.filter((plugin) => !(Array.isArray(plugin) && plugin[0] === "@semantic-release/github")) };\n',
  );
  writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
  symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
  git("add", ".");
  git("commit", "-m", "chore: bootstrap fixture");
  git("tag", "v0.1.0");
  git("branch", "next");
  git("branch", "dev");
  git("push", "origin", "main", "next", "dev", "--tags");

  async function run(dry = true, expectedVersion = ""): Promise<string> {
    const result = Bun.spawn(["bunx", "--no-install", "semantic-release", ...(dry ? ["--dry-run"] : []), "--no-ci"], {
      cwd,
      env: {
        ...process.env,
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        GITHUB_ACTIONS: "",
        GITHUB_REF: "",
        GITHUB_SHA: "",
        CI: "",
        EXPECTED_VERSION: expectedVersion,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(result.stdout).text(),
      new Response(result.stderr).text(),
      result.exited,
    ]);

    const output = stdout + stderr;

    if (code !== 0) throw new Error(output);

    return output;
  }

  const remoteTags = () =>
    execFileSync("git", ["tag", "--list"], { cwd: remote, encoding: "utf8" }).trim().split("\n").sort();

  return {
    git,
    cwd,
    remoteTags,
    dryRun: () => run(),
    release: (dry = true) => run(dry),
    releases: (records: { tag_name: string; draft: boolean; prerelease: boolean }[]) =>
      writeFileSync(join(cwd, "releases.json"), JSON.stringify(records)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function runPinned(
  cwd: string,
  branch: string,
  sha: string,
  dry = true,
  expectedVersion = "",
  workflowBranch = branch,
) {
  const child = Bun.spawn(["node", "pinned-release.mjs", "--no-ci", ...(dry ? ["--dry-run"] : [])], {
    cwd,
    env: {
      ...Bun.env,
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      GITHUB_ACTIONS: "true",
      CI: "true",
      GITHUB_REF: `refs/heads/${workflowBranch}`,
      GITHUB_REF_NAME: workflowBranch,
      RELEASE_BRANCH: branch,
      GITHUB_REF_TYPE: "branch",
      GITHUB_SHA: sha,
      EXPECTED_SHA: sha,
      EXPECTED_VERSION: expectedVersion,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) throw new Error(stdout + stderr);

  return stdout + stderr;
}

test("Release accepts the event SHA and rejects a checkout that differs from the dispatch", () => {
  const repo = fixture();
  const expected = repo.git("rev-parse", "HEAD");

  const run = (expectedSha: string) =>
    Bun.spawnSync(["node", "pinned-release.mjs", "--dry-run", "--no-ci"], {
      cwd: repo.cwd,
      env: {
        ...process.env,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        GITHUB_ACTIONS: "",
        CI: "",
        GITHUB_OUTPUT: join(repo.cwd, "release-output"),
        EXPECTED_SHA: expectedSha,
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_NAME: "main",
        GITHUB_REF_TYPE: "branch",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

  const current = run(expected);
  expect(current.exitCode, current.stderr.toString()).toBe(0);
  expect(current.stdout.toString()).not.toContain("Resuming");
  repo.git("commit", "--allow-empty", "-m", "fix: branch moved");
  const newer = repo.git("rev-parse", "HEAD");
  repo.git("push", "origin", "main");
  repo.git("checkout", "--detach", expected);
  const push = run(expected);
  expect(push.exitCode).toBe(0);
  expect(push.stdout.toString()).not.toContain("Resuming");
  const dispatch = run(newer);
  expect(dispatch.exitCode).not.toBe(0);
  expect(dispatch.stderr.toString()).toContain("Checkout does not match EXPECTED_SHA");
  expect(repo.remoteTags()).toEqual(["v0.1.0"]);
}, 60_000);

test("bootstrap branches produce no release, then feat produces stable, beta and nightly 0.2.0", async () => {
  const repo = fixture();

  try {
    for (const [branch, version] of [
      ["main", "0.2.0"],
      ["next", "0.2.0-beta.1"],
      ["dev", "0.2.0-nightly.1"],
    ]) {
      repo.git("checkout", branch!);
      expect(await repo.dryRun()).toContain("no new version is released");
      repo.git("commit", "--allow-empty", "-m", "feat: add release fixture feature");
      repo.git("push", "origin", branch!);
      expect(await repo.dryRun()).toContain(`Published release ${version} on`);
    }
  } finally {
    repo.cleanup();
  }
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
    const sha = repo.git("rev-parse", "HEAD");
    repo.git("push", "origin", `${sha}:refs/heads/dev`);
    repo.git("checkout", "--detach", sha);
    repo.releases([{ tag_name: "v1.0.0", draft: false, prerelease: false }]);
    expect(await runPinned(repo.cwd, "dev", sha)).toContain("Published release 2.0.0-nightly.1 on");
  } finally {
    repo.cleanup();
  }
}, 60_000);

test("release versions assign Docker aliases exclusively to their channel", () => {
  const commit = "abc123456789";
  expect(resolveVersion({ commit, tag: "v0.1.0" }).dockerTags).toEqual(["v0.1.0", "v0.1", "v0", "latest", "stable"]);
  expect(resolveVersion({ commit, tag: "v0.2.0-beta.1" }).dockerTags).toEqual(["v0.2.0-beta.1", "beta"]);
  expect(resolveVersion({ commit, tag: "v0.2.0-nightly.1" }).dockerTags).toEqual(["v0.2.0-nightly.1", "nightly"]);
  expect(resolveVersion({ commit }).dockerTags).toEqual([]);
});

test("manifest preserves the exact version/channel and rejects contradictory release metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "canopy-release-manifest-unit-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "canopy-worker-linux-x64"), "fixture binary");

  const env = {
    GITHUB_SHA: "abc123456789",
    CANOPY_VERSION: "0.2.0-beta.1",
    CANOPY_RELEASE_TAG: "v0.2.0-beta.1",
    CANOPY_CHANNEL: "beta",
  };

  const manifest = await releaseManifest(directory, env);
  expect(manifest.version).toBe("0.2.0-beta.1");
  expect(manifest.channel).toBe("beta");
  expect(manifest.assets[0]?.url).toContain("/v0.2.0-beta.1/canopy-worker-linux-x64");
  writeFileSync(join(directory, "beta-mac.yml"), "desktop feed");
  writeFileSync(join(directory, "Canopy-0.2.0-beta.1-darwin-arm64.zip.blockmap"), "desktop blockmap");
  expect((await releaseManifest(directory, env)).assets).toEqual(manifest.assets);
  writeFileSync(join(directory, "nightly-mac.yml"), "wrong channel");
  await expect(releaseManifest(directory, env)).rejects.toThrow("Not a release asset");
  await expect(releaseManifest(directory, { ...env, CANOPY_CHANNEL: "stable" })).rejects.toThrow("must match");
});

test("publication reads the protocol constants from the release SHA instead of its tooling checkout", () => {
  const { cwd, git } = fixture();
  const directory = join(cwd, "assets");
  const protocolPath = join(cwd, "packages/domain/src/release");
  const protocolFile = join(protocolPath, "protocol.ts");
  mkdirSync(directory);
  mkdirSync(protocolPath, { recursive: true });

  for (const name of ["release-manifest.ts", "version.ts"])
    copyFileSync(join(root, "scripts", name), join(cwd, "scripts", name));
  writeFileSync(protocolFile, "export const WORKER_LINK_PROTOCOL = 4;\nexport const UPDATE_PROTOCOL = 1;\n");
  git("add", ".");
  git("commit", "-m", "chore: fixture for released protocol");
  const sha = git("rev-parse", "HEAD");
  writeFileSync(protocolFile, "export const WORKER_LINK_PROTOCOL = 5;\nexport const UPDATE_PROTOCOL = 1;\n");

  const child = Bun.spawnSync([process.execPath, "scripts/release-manifest.ts", directory], {
    cwd,
    env: {
      ...Bun.env,
      GITHUB_SHA: sha,
      GITHUB_REF_TYPE: "branch",
      CANOPY_VERSION: "0.2.0",
      CANOPY_RELEASE_TAG: "v0.2.0",
      CANOPY_CHANNEL: "stable",
      CANOPY_PROTOCOL_REVISION: sha,
    },
  });

  expect(child.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")).protocol).toEqual({
    worker_link: 4,
    update: 1,
  });
});

test.each([
  { channel: "stable", version: "0.2.0", feeds: ["latest", "beta"] },
  { channel: "beta", version: "0.2.0-beta.1", feeds: ["beta"] },
  { channel: "nightly", version: "0.2.0-nightly.1", feeds: ["nightly"] },
] as const)(
  "Windows $channel publication preserves installer, feeds, blockmap and updater eligibility",
  async ({ channel, version, feeds }) => {
    const directory = mkdtempSync(join(tmpdir(), "canopy-release-windows-unit-"));
    temporaryDirectories.push(directory);
    const artifact = join(directory, "artifacts/desktop-windows-x64");
    const assets = join(directory, "assets");
    mkdirSync(artifact, { recursive: true });
    const name = `Canopy-${version}-windows-x64.exe`;
    const installer = Buffer.from(`Windows installer ${version}`);
    const sha512 = createHash("sha512").update(installer).digest("base64");
    writeFileSync(join(artifact, name), installer);
    writeFileSync(join(artifact, `${name}.blockmap`), "Windows installer blockmap");
    writeFileSync(
      join(artifact, `${feeds[0]}.yml`),
      JSON.stringify({ version, files: [{ url: name, sha512, size: installer.length }], path: name, sha512 }),
    );

    await mergeDesktopUpdates(join(directory, "artifacts"), assets, channel, version);

    const manifest = await writeReleaseFiles(assets, {
      CANOPY_VERSION: version,
      CANOPY_CHANNEL: channel,
      CANOPY_RELEASE_TAG: `v${version}`,
      GITHUB_SHA: "abc123456789",
    });

    expect(manifest.assets).toEqual([expect.objectContaining({ app: "desktop", os: "windows", arch: "x64", name })]);
    expect(readFileSync(join(assets, name))).toEqual(installer);

    const checksums = readFileSync(join(assets, "checksums.txt"), "utf8");

    for (const file of [name, `${name}.blockmap`, ...feeds.map((feed) => `${feed}.yml`)]) {
      const contents = readFileSync(join(assets, file));
      expect(checksums).toContain(`${createHash("sha256").update(contents).digest("hex")}  ${file}\n`);
    }

    for (const feed of feeds) {
      expect(readFileSync(join(assets, `${feed}.yml`), "utf8")).toContain(sha512);
      expect(
        newestRelease(
          [
            {
              tag_name: `v${version}`,
              draft: false,
              prerelease: channel !== "stable",
              assets: readdirSync(assets).map((name) => ({ name })),
            },
          ],
          "0.1.0",
          feed === "latest" ? "stable" : feed,
          `${feed}.yml`,
        )?.tag_name,
      ).toBe(`v${version}`);
    }
  },
);

const releaseRecord = (tag_name: string, draft = false) => ({ tag_name, draft, prerelease: tag_name.includes("-") });

test("public Beta closes old Nightly drafts while a newer Nightly leaves its Stable promotion intact", async () => {
  const repo = fixture();
  repo.git("tag", "v0.5.0");
  repo.git("checkout", "dev");
  repo.git("commit", "--allow-empty", "-m", "feat: feature for stabilization");
  const betaSha = repo.git("rev-parse", "HEAD");
  repo.git("tag", "v0.6.0-nightly.4");
  repo.git("notes", "--ref=semantic-release-v0.6.0-nightly.4", "add", "-m", '{"channels":["nightly"]}');
  repo.git("branch", "-f", "next", betaSha);
  repo.git("commit", "--allow-empty", "-m", "fix: first change in the next train");
  const nightlySha = repo.git("rev-parse", "HEAD");
  repo.git("push", "origin", "next", "dev", "--tags", "refs/notes/*:refs/notes/*");
  const published = ["v0.5.0", "v0.6.0-nightly.4"].map((tag) => releaseRecord(tag));
  repo.releases(published);
  await runPinned(repo.cwd, "dev", nightlySha, false, "0.6.0-nightly.5");

  const oldDraft = releaseRecord("v0.6.0-nightly.5", true);
  repo.git("checkout", "--detach", betaSha);
  await runPinned(repo.cwd, "next", betaSha, false, "0.6.0-beta.1");
  repo.releases([...published, oldDraft, releaseRecord("v0.6.0-beta.1", true)]);
  repo.git("checkout", "--detach", nightlySha);
  expect(await runPinned(repo.cwd, "dev", nightlySha)).toContain("Resuming v0.6.0-nightly.5");
  published.push(releaseRecord("v0.6.0-beta.1"));
  repo.releases([...published, oldDraft]);
  repo.git("checkout", "--detach", betaSha);
  expect(await runPinned(repo.cwd, "dev", betaSha)).toContain("no new version is released");
  repo.git("checkout", "--detach", "v0.5.0");
  expect(await runPinned(repo.cwd, "dev", repo.git("rev-parse", "HEAD"))).toContain("no new version is released");
  repo.git("checkout", "--detach", nightlySha);

  await expect(runPinned(repo.cwd, "dev", nightlySha, false, "0.6.0-nightly.5")).rejects.toThrow(
    "Planned 0.6.0-nightly.5 but the release would be 0.7.0-nightly.1",
  );
  expect(await runPinned(repo.cwd, "dev", nightlySha)).toContain("The next release version is 0.7.0-nightly.1");
  repo.releases([...published, releaseRecord(oldDraft.tag_name)]);
  expect(await runPinned(repo.cwd, "dev", nightlySha)).toContain("The next release version is 0.7.0-nightly.1");
  await runPinned(repo.cwd, "dev", nightlySha, false, "0.7.0-nightly.1");
  expect(repo.git("ls-remote", "origin", "refs/tags/v0.6.0-nightly.5")).toBe(
    `${nightlySha}	refs/tags/v0.6.0-nightly.5`,
  );

  const draftPath = join(repo.cwd, "draft.json");
  const draft = readFileSync(draftPath, "utf8");
  rmSync(draftPath);
  expect(await runPinned(repo.cwd, "dev", nightlySha, false, "0.7.0-nightly.1")).toContain("Resuming v0.7.0-nightly.1");
  expect(JSON.parse(readFileSync(draftPath, "utf8"))).toEqual(JSON.parse(draft));
  expect(draft).toContain("/compare/v0.6.0-beta.1...v0.7.0-nightly.1");

  published.push(releaseRecord("v0.7.0-nightly.1"));
  repo.releases(published);
  repo.git("checkout", "main");
  repo.git("merge", "--ff-only", betaSha);
  repo.git("push", "origin", "main");
  expect(await runPinned(repo.cwd, "main", betaSha, false, "0.6.0")).toContain("Published release 0.6.0 on default");
  expect(repo.git("rev-parse", "v0.6.0^{commit}")).toBe(betaSha);
  repo.git("commit", "--allow-empty", "-m", "docs: explain promotion");
  repo.git("push", "origin", "main");
  expect(await runPinned(repo.cwd, "main", repo.git("rev-parse", "HEAD"))).toContain("no new version is released");
}, 60_000);

test.each([{ annotated: false }, { annotated: true }])(
  "nightly.147 remains visible beside beta.1 (annotated promotion: $annotated)",
  async ({ annotated }) => {
    const repo = fixture();
    repo.git("checkout", "dev");
    repo.git("commit", "--allow-empty", "-m", "feat: previous nightly");
    repo.git("tag", "v0.2.0-nightly.146");
    repo.git("notes", "--ref=semantic-release-v0.2.0-nightly.146", "add", "-m", '{"channels":["nightly"]}');
    repo.git("commit", "--allow-empty", "-m", "fix: promoted nightly");
    const promoted = repo.git("rev-parse", "HEAD");
    repo.git("tag", "v0.2.0-nightly.147");
    repo.git("notes", "--ref=semantic-release-v0.2.0-nightly.147", "add", "-m", '{"channels":["nightly"]}');
    repo.git("tag", ...(annotated ? ["-a", "-m", "Beta promotion"] : []), "v0.2.0-beta.1");
    repo.git("notes", "--ref=semantic-release-v0.2.0-beta.1", "add", "-m", '{"channels":["beta"]}', "v0.2.0-beta.1");
    repo.git("branch", "-f", "next", promoted);
    repo.git("commit", "--allow-empty", "-m", "fix: first change after promotion");
    const sha = repo.git("rev-parse", "HEAD");
    repo.git("push", "origin", "dev", "next", "--tags", "refs/notes/*:refs/notes/*");
    const refs = repo.git("ls-remote", "origin");
    const output = await runPinned(repo.cwd, "dev", sha);
    expect(output).toContain("Found git tag v0.2.0-nightly.147 associated with version 0.2.0-nightly.147");
    expect(output).toContain("Found 1 commits since last release");
    expect(output).toContain("The next release version is 0.2.0-nightly.148");
    expect(repo.git("ls-remote", "origin")).toBe(refs);
    expect(repo.git("notes", "--ref=semantic-release-v0.2.0-nightly.147", "show", "v0.2.0-nightly.147")).toBe(
      '{"channels":["nightly"]}',
    );
    expect(repo.git("notes", "--ref=semantic-release-v0.2.0-beta.1", "show", "v0.2.0-beta.1")).toBe(
      '{"channels":["beta"]}',
    );
  },
  60_000,
);

test("Beta fixes increment the counter until the stable branch reserves the core", async () => {
  const repo = fixture();
  const published: ReturnType<typeof releaseRecord>[] = [];

  const commitNext = (message: string) => {
    repo.git("checkout", "next");
    repo.git("commit", "--allow-empty", "-m", message);
    repo.git("push", "origin", "next");

    return repo.git("rev-parse", "HEAD");
  };

  const publishBeta = async (sha: string, version: string) => {
    expect(await runPinned(repo.cwd, "next", sha, false, version)).toContain(`Published release ${version} on beta`);
    published.push(releaseRecord(`v${version}`));
    repo.releases(published);
  };

  await publishBeta(commitNext("feat: stabilize a feature"), "0.2.0-beta.1");
  const tested = commitNext("fix: update the candidate");
  await publishBeta(tested, "0.2.0-beta.2");
  const late = commitNext("fix: prepare a follow-up after stable");

  await runPinned(repo.cwd, "next", late, false, "0.2.0-beta.3");
  repo.releases([...published, releaseRecord("v0.2.0-beta.3", true)]);
  repo.git("push", "origin", `${tested}:refs/heads/main`);
  expect(repo.remoteTags()).not.toContain("v0.2.0");
  expect(await runPinned(repo.cwd, "next", late)).toContain("The next release version is 0.2.1-beta.1");
  await expect(runPinned(repo.cwd, "next", late, false, "0.2.0-beta.3")).rejects.toThrow(
    "Planned 0.2.0-beta.3 but the release would be 0.2.1-beta.1",
  );
  repo.git("checkout", "--detach", tested);
  await runPinned(repo.cwd, "main", tested, false, "0.2.0");
  repo.git("checkout", "--detach", late);
  await publishBeta(late, "0.2.1-beta.1");
  expect(repo.git("ls-remote", "origin", "refs/tags/v0.2.0-beta.3")).toBe(`${late}	refs/tags/v0.2.0-beta.3`);

  repo.git("checkout", "--detach", tested);
  expect(await runPinned(repo.cwd, "main", tested)).toContain("Resuming v0.2.0");
  repo.releases([...published, releaseRecord("v0.2.0")]);
  repo.git("checkout", "dev");
  repo.git("commit", "--allow-empty", "-m", "docs: describe the beta fix");
  repo.git("merge", "--no-ff", late, "-m", "chore: back-merge the tested fixes");
  repo.git("push", "origin", "dev");
  expect(await runPinned(repo.cwd, "dev", repo.git("rev-parse", "HEAD"))).toContain("no new version is released");
  repo.git("commit", "--allow-empty", "-m", "fix: first development-only change");
  repo.git("push", "origin", "dev");
  expect(await runPinned(repo.cwd, "dev", repo.git("rev-parse", "HEAD"))).toContain("0.3.0-nightly.1");
}, 60_000);

test("legacy channel notes remain readable beside tag-specific promotion notes", async () => {
  const repo = fixture();
  repo.git("checkout", "dev");
  repo.git("commit", "--allow-empty", "-m", "feat: legacy nightly");
  repo.git("tag", "v0.2.0-nightly.1");
  repo.git("notes", "--ref=semantic-release", "add", "-m", '{"channels":["nightly"]}');
  repo.git("tag", "v0.2.0-beta.1");
  repo.git("notes", "--ref=semantic-release-v0.2.0-beta.1", "add", "-m", '{"channels":["beta"]}');
  repo.git("commit", "--allow-empty", "-m", "fix: change after legacy nightly");
  repo.git("push", "origin", "dev", "--tags", "refs/notes/*:refs/notes/*");
  expect(await repo.dryRun()).toContain("The next release version is 0.2.0-nightly.2");
}, 60_000);

test.each([{ dry: true }, { dry: false }])(
  "existing tags outside branch history fail before tagging (dry run: $dry)",
  async ({ dry }) => {
    const repo = fixture();
    repo.git("checkout", "dev");
    repo.git("commit", "--allow-empty", "-m", "feat: current feature");
    const sha = repo.git("rev-parse", "HEAD");
    repo.git("push", "origin", "dev");
    repo.git("checkout", "--detach", "v0.1.0");
    repo.git("commit", "--allow-empty", "-m", "feat: conflicting history");
    repo.git("tag", "v0.2.0-nightly.1");
    repo.git("push", "origin", "--tags");
    repo.git("checkout", "dev");
    const refs = repo.git("ls-remote", "origin");
    const local = repo.git("show-ref");
    const message = "Release computed v0.2.0-nightly.1, but that tag already exists; nothing was tagged";
    await expect(runPinned(repo.cwd, "dev", sha, dry)).rejects.toThrow(message);
    await expect(repo.release(dry)).rejects.toThrow(message);
    expect(repo.git("ls-remote", "origin")).toBe(refs);
    expect(repo.git("show-ref")).toBe(local);
    expect(() => readFileSync(join(repo.cwd, "draft.json"))).toThrow();
  },
  60_000,
);

test.each([
  ["dev", "0.2.0-nightly.1", "0.2.0-nightly.2"],
  ["next", "0.2.0-beta.1", "0.2.0-beta.2"],
  ["main", "0.2.0", "0.2.1"],
])(
  "%s releases consecutive pinned snapshots after the branch moves",
  async (branch, first, second) => {
    const repo = fixture();
    repo.git("checkout", branch!);
    repo.git("commit", "--allow-empty", "-m", "feat: first merge");
    const pinned = repo.git("rev-parse", "HEAD");
    repo.git("commit", "--allow-empty", "-m", "fix: second merge");
    const newer = repo.git("rev-parse", "HEAD");
    repo.git("push", "origin", branch!);

    if (branch === "main") {
      repo.git("tag", "-a", "v0.2.0-beta.1", pinned, "-m", "Beta promotion");
      repo.git("tag", "v0.2.1-beta.1", newer);
      repo.git("push", "origin", "--tags");
      repo.releases([releaseRecord("v0.2.0-beta.1"), releaseRecord("v0.2.1-beta.1")]);
    }

    const previousTags = repo.remoteTags();
    repo.git("checkout", "--detach", pinned);
    // The branch has already moved before planning, then moves again during checks/builds.
    expect(await runPinned(repo.cwd, branch!, pinned)).toContain(`Published release ${first} on`);
    expect(repo.remoteTags()).toEqual(previousTags);
    repo.git("checkout", branch!);
    repo.git("reset", "--hard", newer);
    repo.git("commit", "--allow-empty", "-m", "fix: third merge");
    const tip = repo.git("rev-parse", "HEAD");
    repo.git("push", "origin", branch!);

    repo.git("checkout", "--detach", pinned);
    await expect(runPinned(repo.cwd, branch!, pinned, false, second)).rejects.toThrow(
      `Planned ${second} but the release would be ${first}`,
    );
    expect(repo.remoteTags()).toEqual(previousTags);
    expect(await runPinned(repo.cwd, branch!, pinned, false, first)).toContain(`Published release ${first} on`);
    expect(repo.git("ls-remote", "origin", `refs/tags/v${first}`)).toBe(`${pinned}\trefs/tags/v${first}`);
    expect(repo.git("ls-remote", "origin", `refs/heads/${branch}`)).toBe(`${tip}\trefs/heads/${branch}`);
    const noteRef = `refs/notes/semantic-release-v${first}`;
    expect(repo.git("ls-remote", "origin", noteRef)).toBe(`${repo.git("rev-parse", noteRef)}\t${noteRef}`);
    const draft = JSON.parse(readFileSync(join(repo.cwd, "draft.json"), "utf8"));
    expect(draft).toEqual(
      expect.objectContaining({
        tag_name: `v${first}`,
        target_commitish: pinned,
        draft: true,
        prerelease: branch !== "main",
      }),
    );
    expect(draft.body).toContain("first merge");
    expect(draft.body).not.toContain("second merge");
    expect(draft.body).not.toContain("canopy-release-snapshot-");
    expect(draft.body).toContain(`/compare/v0.1.0...v${first}`);
    // Only after A finishes may B plan. Its own pinned SHA can also be behind the current tip.
    repo.git("update-ref", "-d", noteRef);
    repo.git("checkout", "--detach", newer);
    expect(await runPinned(repo.cwd, branch!, newer)).toContain(`Published release ${second} on`);
    expect(await runPinned(repo.cwd, branch!, newer, false, second)).toContain(`Published release ${second} on`);
    expect(repo.git("ls-remote", "origin", `refs/tags/v${second}`)).toBe(`${newer}\trefs/tags/v${second}`);
    expect(repo.remoteTags()).toEqual([...previousTags, `v${first}`, `v${second}`].sort());
  },
  60_000,
);

test("Release refuses a pinned SHA removed from the branch by a force push", async () => {
  const repo = fixture();
  repo.git("checkout", "dev");
  repo.git("commit", "--allow-empty", "-m", "feat: removed feature");
  const pinned = repo.git("rev-parse", "HEAD");
  repo.git("push", "origin", "dev");
  repo.git("reset", "--hard", "v0.1.0");
  repo.git("commit", "--allow-empty", "-m", "fix: replacement history");
  repo.git("push", "--force", "origin", "dev");
  repo.git("checkout", "--detach", pinned);
  await expect(runPinned(repo.cwd, "dev", pinned)).rejects.toThrow("refusing rewritten history");
  await expect(runPinned(repo.cwd, "dev", pinned, false)).rejects.toThrow("refusing rewritten history");
  expect(repo.remoteTags()).toEqual(["v0.1.0"]);
});

test.each([
  ["dev", "0.2.0-nightly.1"],
  ["next", "0.2.0-beta.1"],
  ["main", "0.2.0"],
])(
  "%s resumes the reserved version after a lost draft POST without changing any refs",
  async (branch, version) => {
    const repo = fixture();
    repo.git("checkout", branch!);
    repo.git("commit", "--allow-empty", "-m", "feat(web): reserved feature (#600)\n\nA long PR body");
    const sha = repo.git("rev-parse", "HEAD");
    repo.git("push", "origin", branch!);

    if (branch === "main") {
      repo.git("tag", "v0.2.0-beta.1", sha);
      repo.git("push", "origin", "--tags");
      repo.releases([releaseRecord("v0.2.0-beta.1")]);
    }

    await runPinned(repo.cwd, branch!, sha, false, version);
    const tag = `v${version}`;
    const refs = repo.git("ls-remote", "origin");
    const original = readFileSync(join(repo.cwd, "draft.json"), "utf8");
    rmSync(join(repo.cwd, "draft.json"));
    repo.git("commit", "--allow-empty", "-m", "fix: later commit");
    repo.git("push", "origin", branch!);
    repo.git("checkout", "--detach", sha);
    const movedRefs = repo.git("ls-remote", "origin");
    expect(movedRefs).not.toBe(refs);
    expect(await runPinned(repo.cwd, branch!, sha, true, "", "dev")).toContain(`Resuming ${tag}`);
    expect(() => readFileSync(join(repo.cwd, "draft.json"))).toThrow();
    await expect(runPinned(repo.cwd, branch!, sha, false, "9.9.9")).rejects.toThrow("but the existing tag is");
    expect(await runPinned(repo.cwd, branch!, sha, false, version, "dev")).toContain(`Resuming ${tag}`);
    const recovered = readFileSync(join(repo.cwd, "draft.json"), "utf8");
    expect(JSON.parse(recovered)).toEqual(JSON.parse(original));
    expect(recovered).not.toContain("later commit");
    expect(recovered).not.toContain("A long PR body");
    await runPinned(repo.cwd, branch!, sha, false, version);
    expect(readFileSync(join(repo.cwd, "draft.json"), "utf8")).toBe(recovered);
    writeFileSync(join(repo.cwd, "draft.json"), JSON.stringify({ ...JSON.parse(recovered), draft: false }));
    expect(await runPinned(repo.cwd, branch!, sha, false, version)).not.toContain("Resuming");
    expect(repo.git("ls-remote", "origin")).toBe(movedRefs);
  },
  60_000,
);

test("recovery refuses ambiguous tags and missing channel metadata", async () => {
  const repo = fixture();
  repo.git("checkout", "next");
  repo.git("commit", "--allow-empty", "-m", "feat: reserve beta");
  const sha = repo.git("rev-parse", "HEAD");
  repo.git("push", "origin", "next");
  repo.git("tag", "v0.2.0-beta.1");
  repo.git("push", "origin", "--tags");
  await expect(runPinned(repo.cwd, "next", sha)).rejects.toThrow();
  repo.git("notes", "--ref=semantic-release-v0.2.0-beta.1", "add", "-m", '{"channels":["nightly"]}', "v0.2.0-beta.1");
  repo.git("push", "origin", "refs/notes/semantic-release-v0.2.0-beta.1");
  await expect(runPinned(repo.cwd, "next", sha)).rejects.toThrow("metadata for this channel");
  repo.git("tag", "v0.2.0-beta.2");
  repo.git("push", "origin", "--tags");
  await expect(runPinned(repo.cwd, "next", sha)).rejects.toThrow("Multiple release tags");
});

test("server-then-desktop publication keeps checksums.txt and manifest.json consistent and repeatable", async () => {
  const base = mkdtempSync(join(tmpdir(), "canopy-release-stages-unit-"));
  temporaryDirectories.push(base);

  const assets = join(base, "release-assets"),
    artifacts = join(base, "desktop-artifacts");

  const version = "0.2.0-nightly.3";

  const env = {
    GITHUB_SHA: "abc123456789",
    GITHUB_REPOSITORY: "itsoltech/canopy",
    CANOPY_VERSION: version,
    CANOPY_RELEASE_TAG: `v${version}`,
    CANOPY_CHANNEL: "nightly",
  };

  mkdirSync(assets);

  for (const name of ["canopy-gateway-linux-x64", "canopy-worker-linux-x64", "canopy-worker-windows-x64.exe"])
    writeFileSync(join(assets, name), `binary ${name}`);
  writeFileSync(join(assets, "canopy-worker-windows-x64.exe.licenses.txt"), "Canopy third-party notices\n");
  const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

  const consistent = (manifest: Awaited<ReturnType<typeof writeReleaseFiles>>) => {
    const files = readdirSync(assets)
      .filter((name) => name !== "checksums.txt" && name !== "manifest.json")
      .sort();

    const checksums = readFileSync(join(assets, "checksums.txt"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("  "));

    expect(checksums.map(([, name]) => name)).toEqual(files);

    for (const [hash, name] of checksums) expect(hash).toBe(sha256(join(assets, name!)));
    expect(JSON.parse(readFileSync(join(assets, "manifest.json"), "utf8"))).toEqual(manifest);

    for (const asset of manifest.assets) {
      expect(files).toContain(asset.name);
      expect(asset.sha256).toBe(sha256(join(assets, asset.name)));
      expect(asset.url).toBe(`https://github.com/itsoltech/canopy/releases/download/v${version}/${asset.name}`);
    }
  };

  // Stage 1: server assets only.
  const server = await writeReleaseFiles(assets, env);
  consistent(server);
  expect(server.assets.map((asset) => asset.app)).toEqual(["gateway", "worker", "worker"]);
  // Stage 2: one desktop target finished (the other failed); feeds are merged next to the binaries.
  const linux = join(artifacts, "desktop-linux-x64");
  mkdirSync(linux, { recursive: true });
  const installer = `Canopy-${version}-linux-x64.AppImage`;
  writeFileSync(join(linux, installer), "appimage");
  writeFileSync(join(linux, `${installer}.blockmap`), "blockmap");
  const sha512 = new Bun.CryptoHasher("sha512").update("appimage").digest("base64");
  writeFileSync(
    join(linux, "nightly-linux.yml"),
    `version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: ${sha512}\n    size: 8\npath: ${installer}\nsha512: ${sha512}\n`,
  );
  // download-artifact v5 flattens its output when only one target succeeds.
  await mergeDesktopUpdates(linux, assets, "nightly", version);
  const desktop = await writeReleaseFiles(assets, env);
  consistent(desktop);
  expect(desktop.assets.filter((asset) => asset.app !== "desktop")).toEqual([...server.assets]);
  expect(desktop.assets.filter((asset) => asset.app === "desktop").map((asset) => asset.name)).toEqual([installer]);
  expect(readFileSync(join(assets, "checksums.txt"), "utf8")).toContain("  nightly-linux.yml\n");
  // "Re-run failed jobs" adds the missing target: the same files are merged again plus the new one.
  const mac = join(artifacts, "desktop-darwin-arm64");
  mkdirSync(mac);
  const zip = `Canopy-${version}-darwin-arm64.zip`;
  writeFileSync(join(mac, zip), "zip");
  const zipSha512 = new Bun.CryptoHasher("sha512").update("zip").digest("base64");
  writeFileSync(
    join(mac, "nightly-mac.yml"),
    `version: ${version}\nfiles:\n  - url: ${zip}\n    sha512: ${zipSha512}\n    size: 3\npath: ${zip}\nsha512: ${zipSha512}\n`,
  );
  const rerun = join(base, "rerun-assets");
  mkdirSync(rerun);

  for (const asset of server.assets) copyFileSync(join(assets, asset.name), join(rerun, asset.name));
  await mergeDesktopUpdates(artifacts, rerun, "nightly", version);
  const repeated = await writeReleaseFiles(rerun, env);
  expect(repeated.assets.filter((asset) => asset.name !== zip)).toEqual([...desktop.assets]);
  expect(repeated.assets.find((asset) => asset.name === zip)?.app).toBe("desktop");
  const again = await writeReleaseFiles(rerun, env);
  expect({ ...again, published_at: "" }).toEqual({ ...repeated, published_at: "" });
});
