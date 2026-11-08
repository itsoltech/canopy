import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const iosRuntime = "a".repeat(40);
const androidRuntime = "b".repeat(40);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type Scenario = {
  ios?: boolean;
  android?: boolean;
  pending?: boolean;
  docsOnly?: boolean;
  recent?: boolean;
  published?: boolean;
  signed?: boolean;
  messageSuffix?: string;
  rollback?: boolean;
  mappedBranch?: string;
  fail?: string;
  baselineHead?: boolean;
  firstRelease?: boolean;
};

function fixture(options: Scenario = {}) {
  const root = mkdtempSync(join(tmpdir(), "canopy-mobile-release-"));
  directories.push(root);
  const cwd = join(root, "apps/mobile");
  const bin = join(root, "bin");
  const responses = join(root, "responses");

  for (const directory of [cwd, bin, responses, join(root, "scripts")]) mkdirSync(directory, { recursive: true });

  for (const script of ["mobile-release.sh", "mobile-publish-update.sh"])
    copyFileSync(resolve("scripts", script), join(root, "scripts", script));
  symlinkSync(resolve("scripts/fixtures/mobile-eas.sh"), join(bin, "bunx"));
  writeFileSync(join(cwd, "app.json"), JSON.stringify({ expo: { version: "1.0.0" } }));

  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Canopy test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
    });

    expect(result.exitCode).toBe(0);

    return result.stdout.toString().trim();
  };

  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "initial native runtime");
  const previous = git("rev-parse", "HEAD");
  writeFileSync(join(options.docsOnly ? root : cwd, "change.md"), "release change");
  git("add", ".");
  git("commit", "--quiet", "-m", "release change");
  const head = git("rev-parse", "HEAD");
  const output = join(root, "output");
  writeFileSync(output, "");
  const message = `Canopy v0.2.0-beta.1 (${head})`;
  const build = { gitCommitHash: previous, status: "FINISHED", runtimeVersion: iosRuntime };

  const update = {
    group: "group",
    runtimeVersion: iosRuntime,
    codeSigningKey: options.signed ? "canopy-updates" : null,
    message: `"${message}${options.messageSuffix ?? ""}" (now by test)`,
    isRollBackToEmbedded: options.rollback ?? false,
  };

  const data = {
    channels: { currentPage: [{ name: "beta" }] },
    mapping: {
      currentPage: {
        isPaused: false,
        updateBranches: [{ id: "branch", name: options.mappedBranch ?? "beta" }],
        branchMapping: JSON.stringify({ data: [{ branchId: "branch", branchMappingLogic: "true" }] }),
      },
    },
    baseline: options.firstRelease
      ? []
      : [
          {
            ...build,
            gitCommitHash: options.baselineHead ? head : previous,
            runtimeVersion: options.ios ? iosRuntime : "old-runtime",
          },
        ],
    ios: options.ios ? [build] : [],
    android: options.android ? [build] : [],
    pending: options.pending ? [{ ...build, status: "IN_PROGRESS" }] : [{ ...build, status: "ERRORED" }],
    recent: { currentPage: options.recent ? [update] : [] },
    group: ["ios", "android"].map((platform) => ({ platform, gitCommitHash: head })),
    "fingerprint-ios": { hash: iosRuntime },
    "fingerprint-android": { hash: androidRuntime },
    "updates-ios": { currentPage: options.published ? [update] : [] },
    "updates-android": { currentPage: options.published ? [{ ...update, runtimeVersion: androidRuntime }] : [] },
  };

  for (const [name, value] of Object.entries(data))
    writeFileSync(join(responses, `${name}.json`), JSON.stringify(value));

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env["PATH"]}`,
    CHANNEL: "beta",
    PROFILE: "production-beta",
    TAG: "v0.2.0-beta.1",
    MARKETING: "0.2.0",
    HEAD_SHA: head,
    GITHUB_OUTPUT: output,
    CANOPY_MOBILE_TEST_RESPONSES: responses,
    CANOPY_MOBILE_TEST_FAIL: options.fail ?? "",
  };

  return {
    run: () => {
      const result = Bun.spawnSync(["bash", "../../scripts/mobile-release.sh"], { cwd, env });

      return { code: result.exitCode, output: readFileSync(output, "utf8"), error: result.stderr.toString() };
    },
    publish: () => {
      const result = Bun.spawnSync(["bash", "../../scripts/mobile-publish-update.sh"], {
        cwd,
        env: { ...env, MESSAGE: message, EXPO_UPDATES_PRIVATE_KEY: undefined },
      });

      return { code: result.exitCode, output: result.stdout.toString(), error: result.stderr.toString() };
    },
  };
}

test("JS-only releases use OTA when a compatible iOS build exists; Android never requests a build", () => {
  const result = fixture({ ios: true }).run();
  expect(result.code).toBe(0);
  expect(result.output).toContain("ota=true");
  expect(result.output).not.toContain("build=true");
});

test("the first release on a channel without a delivered build builds iOS", () => {
  const result = fixture({ firstRelease: true }).run();
  expect(result.code).toBe(0);
  expect(result.output).toContain("build=true");
});

test("a new native runtime builds iOS; failed builds do not prevent a retry", () => {
  const result = fixture().run();
  expect(result.code).toBe(0);
  expect(result.output).toContain("build=true");
  expect(result.output).not.toContain("ota=true");
});

test("an iOS native change still delivers OTA to a compatible Android APK", () => {
  const result = fixture({ android: true }).run();
  expect(result.code).toBe(0);
  expect(result.output).toContain("build=true");
  expect(result.output).toContain("ota=true");
});

test("a queued native build is not duplicated", () => {
  const result = fixture({ pending: true }).run();
  expect(result.code).toBe(0);
  expect(result.output).not.toMatch(/(?:build|ota)=true/);
});

test("a beta channel pointing at nightly is rejected", () => {
  const result = fixture({ ios: true, mappedBranch: "nightly" }).run();
  expect(result.code).not.toBe(0);
  expect(result.error).toContain("same-name branch");
  expect(result.output).not.toMatch(/(?:build|ota)=true/);
});

test("docs-only changes skip the mobile release", () => {
  const result = fixture({ ios: true, docsOnly: true }).run();
  expect(result.code).toBe(0);
  expect(result.output).not.toMatch(/(?:build|ota)=true/);
});

test("complete unsigned publications with the exact release message are idempotent", () => {
  const result = fixture({ ios: true, published: true }).run();
  expect(result.code).toBe(0);
  expect(result.output).not.toMatch(/(?:build|ota)=true/);
});

test("a publication whose message only starts with the release message does not satisfy deduplication", () => {
  const result = fixture({ ios: true, published: true, messageSuffix: " extra" }).run();
  expect(result.code).toBe(0);
  expect(result.output).toContain("ota=true");
});

test("rollback publications do not satisfy release deduplication", () => {
  const result = fixture({ ios: true, published: true, rollback: true }).run();
  expect(result.code).toBe(0);
  expect(result.output).toContain("ota=true");
});

test("complete legacy signed publications remain idempotent", () => {
  const result = fixture({ ios: true, published: true, signed: true }).run();
  expect(result.code).toBe(0);
  expect(result.output).not.toMatch(/(?:build|ota)=true/);
});

test("a complete unsigned OTA advances the baseline and skips an already delivered commit", () => {
  const result = fixture({ ios: true, recent: true }).run();
  expect(result.code).toBe(0);
  expect(result.output).not.toMatch(/(?:build|ota)=true/);
});

test("an Android OTA after a failed iOS native build cannot hide the missing build", () => {
  const result = fixture({ android: true, recent: true }).run();
  expect(result.code).toBe(0);
  expect(result.output).toContain("build=true");
});

test("an EAS history query failure aborts before publishing", () => {
  const result = fixture({ ios: true, fail: "updates-ios" }).run();
  expect(result.code).not.toBe(0);
  expect(result.output).not.toContain("ota=true");
});

test("a successful same-SHA iOS build still retries a missing Android OTA", () => {
  const result = fixture({ ios: true, android: true, baselineHead: true }).run();
  expect(result.code).toBe(0);
  expect(result.output).not.toContain("build=true");
  expect(result.output).toContain("ota=true");
});

test("publishing succeeds without a signing key", () => {
  const result = fixture().publish();
  expect(result.code).toBe(0);
  expect(result.output).toContain("Published unsigned update.");
});

test("an unsigned publication failure surfaces to the workflow", () => {
  const result = fixture({ fail: "update" }).publish();
  expect(result.code).toBe(12);
  expect(result.error).toContain("Update publication failed.");
});
