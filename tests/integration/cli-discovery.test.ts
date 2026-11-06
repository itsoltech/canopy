/**
 * Agent CLI discovery across package managers (docs/provider-cli.md, "Wykrywanie"): throwaway homes with fake
 * executables laid out the way Bun, Volta, npm (prefix from ~/.npmrc), pnpm and Homebrew lay them out, a JS shim that
 * needs node, a broken symlink, and a fake login shell that prints noise. The worker's real modules find, probe and
 * classify them; the CLI report and the applied configuration must agree. Nothing real is installed or run.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { CliInstallMethod, InstallCliSchema, Provider, WorkerConfigSchema } from "@canopy/contracts";
import { processGovernor } from "@canopy/process-governor";
import { tempDir } from "@canopy/testing";
import { CLIS, deviceCliProbe, discoverCli, type CliProbe } from "../../apps/worker/src/cli-tools/discovery.ts";
import { CliTools } from "../../apps/worker/src/cli-tools/index.ts";
import { withNodeOnPath } from "../../apps/worker/src/cli-tools/locations.ts";
import { classify } from "../../apps/worker/src/cli-tools/managers.ts";
import { planRecipe } from "../../apps/worker/src/cli-tools/recipes.ts";
import { mergeShellEnv, readShellEnv } from "../../apps/worker/src/cli-tools/shell-env.ts";
import { applyWorkerConfig, prepareSystemProbe } from "../../apps/worker/src/config/remote.ts";

const root = tempDir("canopy-cli-discovery-");
const codex = CLIS.find((c) => c.name === "codex")!;
const grok = CLIS.find((c) => c.name === "grok")!;
let homes = 0;

const file = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

const link = (target: string, path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  symlinkSync(target, path);
};

const fakeCli = (version: string) => `#!/bin/sh\necho "codex-cli ${version}"\n`;

/** A fresh home; PATH holds only `path` (no system directories, so no real CLI or node is found). */
function device(path: string[] = [], extra: Record<string, string> = {}) {
  const home = join(root, `home-${++homes}`);
  mkdirSync(home, { recursive: true });
  const env = { HOME: home, PATH: path.map((p) => p.replace("~", home)).join(":"), ...extra };
  const probe = (): CliProbe => deviceCliProbe({ platform: "linux", home, docker: false, env: () => env });

  return { home, env, probe };
}

const recipeOf = (found: Awaited<ReturnType<typeof discoverCli>>, probe: CliProbe) =>
  planRecipe(found, "latest", { platform: "linux", home: probe.home, env: probe.env ?? {}, which: probe.which });

beforeEach(() => processGovernor.invalidate());

describe("agent CLIs from any package manager", () => {
  test("bun: found in ~/.bun/bin when PATH lacks it, updated with bun add -g", async () => {
    const { home, probe } = device();
    file(join(home, ".bun/install/global/node_modules/@openai/codex/bin/codex.js"), fakeCli("0.166.0"));
    link(join(home, ".bun/install/global/node_modules/@openai/codex/bin/codex.js"), join(home, ".bun/bin/codex"));
    file(join(home, ".bun/bin/bun"), "#!/bin/sh\n");

    const found = await discoverCli(codex, undefined, probe());
    expect(found).toMatchObject({
      path: join(home, ".bun/bin/codex"),
      method: CliInstallMethod.BUN,
      version: "0.166.0",
    });
    expect(recipeOf(found, probe()).recipe).toEqual({
      kind: "run",
      argv: [join(home, ".bun/bin/bun"), "add", "--global", "@openai/codex@latest"],
    });
  });

  test("a stale Homebrew copy first on PATH loses to a working bun copy, and is listed with its error", async () => {
    const { home, probe } = device(["~/homebrew/bin"]);
    file(
      join(home, "homebrew/Caskroom/codex/0.100.0/codex"),
      '#!/bin/sh\necho "dyld: Library not loaded" >&2\nexit 134\n',
    );
    link(join(home, "homebrew/Caskroom/codex/0.100.0/codex"), join(home, "homebrew/bin/codex"));
    file(join(home, ".bun/install/global/node_modules/@openai/codex/bin/codex.js"), fakeCli("0.166.0"));
    link(join(home, ".bun/install/global/node_modules/@openai/codex/bin/codex.js"), join(home, ".bun/bin/codex"));

    const found = await discoverCli(codex, undefined, probe());
    expect(found).toMatchObject({
      path: join(home, ".bun/bin/codex"),
      method: CliInstallMethod.BUN,
      version: "0.166.0",
    });
    expect(found.versionError).toBeUndefined();
    expect(found.alternatives).toEqual([
      {
        path: join(home, "homebrew/bin/codex"),
        resolvedPath: join(home, "homebrew/Caskroom/codex/0.100.0/codex"),
        method: CliInstallMethod.HOMEBREW,
        version: "",
        problem: "dyld: Library not loaded",
      },
    ]);
  });

  test("Volta: a volta-shim link is Volta's, updated with volta install", async () => {
    const { home, probe } = device(["~/.volta/bin"]);
    file(join(home, ".volta/bin/volta-shim"), fakeCli("0.165.0"));
    link(join(home, ".volta/bin/volta-shim"), join(home, ".volta/bin/codex"));
    file(join(home, ".volta/bin/volta"), "#!/bin/sh\n");

    const found = await discoverCli(codex, undefined, probe());
    expect(found).toMatchObject({ method: CliInstallMethod.VOLTA, version: "0.165.0" });
    expect(recipeOf(found, probe()).recipe).toEqual({
      kind: "run",
      argv: [join(home, ".volta/bin/volta"), "install", "@openai/codex@latest"],
    });
  });

  test("npm: the global prefix from ~/.npmrc is searched and updated with its own npm", async () => {
    const { home, probe } = device();
    writeFileSync(join(home, ".npmrc"), "fund=false\nprefix = ~/npm-prefix\n");
    file(join(home, "npm-prefix/lib/node_modules/@openai/codex/bin/codex.js"), fakeCli("0.164.0"));
    link(join(home, "npm-prefix/lib/node_modules/@openai/codex/bin/codex.js"), join(home, "npm-prefix/bin/codex"));
    file(join(home, "npm-prefix/bin/npm"), "#!/bin/sh\n");

    const found = await discoverCli(codex, undefined, probe());
    expect(found).toMatchObject({ method: CliInstallMethod.NPM, owner: join(home, "npm-prefix"), version: "0.164.0" });
    expect(recipeOf(found, probe()).recipe).toEqual({
      kind: "run",
      argv: [
        join(home, "npm-prefix/bin/npm"),
        "install",
        "--global",
        "--prefix",
        join(home, "npm-prefix"),
        "--no-fund",
        "--no-audit",
        "@openai/codex@latest",
      ],
    });
  });

  test("npm under Homebrew's prefix is npm's, not Homebrew's", () => {
    const real = "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js";
    expect(classify(codex, "/opt/homebrew/bin/codex", real, { home: "/Users/a" })).toEqual({
      method: CliInstallMethod.NPM,
      owner: "/opt/homebrew",
    });
    expect(
      classify(codex, "/opt/homebrew/bin/codex", "/opt/homebrew/Caskroom/codex/0.1.0/codex", { home: "/Users/a" }),
    ).toEqual({ method: CliInstallMethod.HOMEBREW, owner: "--cask codex" });
  });

  test("pnpm: a script shim in $PNPM_HOME is pnpm's, updated with pnpm add -g", async () => {
    const { home, probe } = device();
    const pnpmHome = join(home, ".local/share/pnpm");
    file(
      join(pnpmHome, "codex"),
      `#!/bin/sh\nbasedir=$(dirname "$0")\n# exec node "$basedir/global/5/node_modules/@openai/codex/bin/codex.js"\necho "codex-cli 0.166.0"\n`,
    );
    file(join(pnpmHome, "pnpm"), "#!/bin/sh\n");

    const found = await discoverCli(codex, undefined, probe());
    expect(found).toMatchObject({ path: join(pnpmHome, "codex"), method: CliInstallMethod.PNPM, version: "0.166.0" });
    expect(recipeOf(found, probe()).recipe).toEqual({
      kind: "run",
      argv: [join(pnpmHome, "pnpm"), "add", "--global", "@openai/codex@latest"],
    });
  });

  test("a JS shim without node says why; with node from Volta appended to PATH it runs", async () => {
    const { home, env, probe } = device();
    const shim = join(home, ".bun/install/global/node_modules/@openai/codex/bin/codex.js");
    file(shim, "#!/usr/bin/env node\nconsole.log('codex-cli 0.166.0')\n");
    link(shim, join(home, ".bun/bin/codex"));

    const broken = await discoverCli(codex, undefined, probe());
    expect(broken).toMatchObject({ path: join(home, ".bun/bin/codex"), method: CliInstallMethod.BUN, version: "" });
    expect(broken.versionError).toContain("node");

    file(join(home, ".volta/bin/node"), '#!/bin/sh\necho "codex-cli 0.166.0"\n');
    env.PATH = withNodeOnPath({ platform: "linux", home, env }) ?? env.PATH;
    expect(env.PATH).toEndWith(join(home, ".volta/bin"));
    processGovernor.invalidate();

    const fixed = await discoverCli(codex, undefined, probe());
    expect(fixed.version).toBe("0.166.0");
    expect(fixed.versionError).toBeUndefined();
  });

  test("a broken symlink is not an install; it is named in the details", async () => {
    const { home, probe } = device();
    link(join(home, ".grok/downloads/grok-1.0.0"), join(home, ".local/bin/grok"));

    const found = await discoverCli(grok, undefined, probe());
    expect(found).toMatchObject({ method: CliInstallMethod.NOT_INSTALLED, path: "", version: "" });
    expect(found.detail).toBe(`${join(home, ".local/bin/grok")} points to a missing file`);
    expect(found.alternatives?.[0]).toMatchObject({
      path: join(home, ".local/bin/grok"),
      problem: "points to a missing file",
    });
  });
});

describe("login shell environment", () => {
  test("PATH and package-manager variables come through startup noise; secrets stay out of the shell", async () => {
    const { home } = device();
    const shell = join(home, "fake-shell");
    file(
      shell,
      [
        "#!/bin/sh",
        'echo "Last login: Mon on ttys001"',
        "printf '\\033[1m❯ prompt\\033[0m\\n'",
        'echo "${FAKE_API_KEY:-none}" > "$HOME/seen"',
        'PATH="$HOME/.bun/bin:$HOME/.volta/bin:/usr/bin:/bin"; export PATH',
        'VOLTA_HOME="$HOME/.volta"; BUN_INSTALL="$HOME/.bun"; export VOLTA_HOME BUN_INSTALL',
        'NVM_BIN="line one\nPATH=/evil"; export NVM_BIN',
        'test "$1 $2 $3" = "-l -i -c" || exit 9',
        '/bin/sh -c "$4"',
        'echo "bye from .zlogout"',
      ].join("\n"),
    );

    const result = await readShellEnv({
      env: { SHELL: shell, HOME: home, PATH: "/usr/bin:/bin", FAKE_API_KEY: "sk-test-0123456789", VOLTA_HOME: "/mine" },
      platform: "linux",
    });

    if (!result.ok) throw new Error(result.reason);
    expect(result.vars["PATH"]).toBe(`${home}/.bun/bin:${home}/.volta/bin:/usr/bin:/bin`);
    expect(result.vars["BUN_INSTALL"]).toBe(`${home}/.bun`);
    // A multi-line value stays one value.
    expect(result.vars["NVM_BIN"]).toBe("line one\nPATH=/evil");
    expect(result.vars["FAKE_API_KEY"]).toBeUndefined();
    expect(readFileSync(join(home, "seen"), "utf8").trim()).toBe("none");

    const merged = mergeShellEnv({ PATH: "/usr/sbin:/usr/bin", VOLTA_HOME: "/mine" }, result.vars);
    expect(merged["PATH"]).toBe(`${home}/.bun/bin:${home}/.volta/bin:/usr/bin:/bin:/usr/sbin`);
    // The worker's own value wins over the shell's.
    expect(merged["VOLTA_HOME"]).toBe("/mine");
    expect(merged["BUN_INSTALL"]).toBe(`${home}/.bun`);
  });

  test("a slow shell times out and leaves the environment as it was; no $SHELL means no lookup", async () => {
    const { home } = device();
    const shell = join(home, "slow-shell");
    file(shell, "#!/bin/sh\nexec sleep 5\n");
    const started = Date.now();
    const slow = await readShellEnv({ env: { SHELL: shell, HOME: home }, platform: "linux", timeoutMs: 300 });
    expect(slow.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(await readShellEnv({ env: { HOME: home }, platform: "linux" })).toEqual({
      ok: false,
      reason: "no login shell",
    });
  });
});

describe("one source of truth", () => {
  test("an install finishing during discovery never reports success with the old version", async () => {
    const { home, env, probe } = device();
    const executable = join(home, ".bun/install/global/node_modules/@openai/codex/bin/codex.js");
    file(executable, fakeCli("0.166.0"));
    link(executable, join(home, ".bun/bin/codex"));
    file(join(home, "updated-codex"), fakeCli("0.170.0"));
    file(join(home, ".bun/bin/bun"), `#!/bin/sh\n/bin/cp '${home}/updated-codex' '${executable}'\n`);
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const installed = Promise.withResolvers<void>();
    const base = probe();
    let hold = true;

    const tools = new CliTools({
      dataDir: join(home, "data"),
      probe: {
        ...base,
        version: async (path) => {
          const result = await base.version(path);

          if (hold) {
            hold = false;
            captured.resolve();
            await release.promise;
          }

          return result;
        },
      },
      env,
      configured: () => ({}),
      send: () => {},
      progress: () => {},
      busy: () => 0,
      installed: async () => installed.resolve(),
      log: () => {},
    });

    const report = tools.report();

    try {
      await captured.promise;
      await tools.start(
        create(InstallCliSchema, { installId: crypto.randomUUID(), provider: Provider.CODEX, version: "0.170.0" }),
      );
      await installed.promise;
    } finally {
      release.resolve();
    }

    const entry = (await report).tools?.find((t) => t.provider === Provider.CODEX);
    expect(entry).toMatchObject({ version: "0.170.0", install: { state: "succeeded" } });
  });

  test("the CLI report and the applied configuration name the same copy and version", async () => {
    const { home, probe } = device(["~/homebrew/bin"]);
    file(join(home, "homebrew/Caskroom/codex/0.100.0/codex"), "#!/bin/sh\nexit 1\n");
    link(join(home, "homebrew/Caskroom/codex/0.100.0/codex"), join(home, "homebrew/bin/codex"));
    file(join(home, ".bun/install/global/node_modules/@openai/codex/bin/codex.js"), fakeCli("0.166.0"));
    link(join(home, ".bun/install/global/node_modules/@openai/codex/bin/codex.js"), join(home, ".bun/bin/codex"));

    const reports: unknown[] = [];

    const tools = new CliTools({
      dataDir: join(home, "data"),
      probe: probe(),
      configured: () => ({}),
      send: (r) => reports.push(r),
      progress: () => {},
      busy: () => 0,
      installed: async () => {},
      log: () => {},
    });

    const report = await tools.report();
    const entry = report.tools?.find((t) => t.provider === Provider.CODEX);
    expect(entry).toMatchObject({
      path: join(home, ".bun/bin/codex"),
      version: "0.166.0",
      method: CliInstallMethod.BUN,
    });
    expect(entry?.alternatives?.map((a) => a.path)).toEqual([join(home, "homebrew/bin/codex")]);

    const config = create(WorkerConfigSchema, { version: 1n, codex: { enabled: true }, grok: { enabled: true } });
    const applied = applyWorkerConfig(config, await prepareSystemProbe(config, probe()));

    if (!applied.applied) throw new Error("config was not applied");
    expect(applied.config.codex).toMatchObject({ enabled: true, executable: entry?.path, version: entry?.version });
    const grokEntry = report.tools?.find((t) => t.provider === Provider.GROK);
    expect(grokEntry?.method).toBe(CliInstallMethod.NOT_INSTALLED);
    expect(applied.config.grok.enabled).toBe(false);
  });
});
