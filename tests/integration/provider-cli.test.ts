/**
 * Provider CLIs end to end (docs/provider-cli.md): a real worker process in a throwaway home with fake CLIs — Claude
 * from its native installer, Codex as an npm global package, Grok not installed — reports them over the worker link;
 * the gateway learns the latest versions from a fake registry; installs and updates run the worker's fixed recipes
 * (a fake `claude install`, a fake npm, a fake official installer script served locally) and the new versions are
 * reported back. A failed install leaves the previous CLI working. The gateway refuses what the UI hides: another
 * owner's worker, a CLI with running turns, Homebrew and container installs. Nothing real is installed; the real
 * home directory is never touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliInstallMethod, PermissionMode, Provider, type ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

const root = tempDir("canopy-provider-cli-");
const home = join(root, "home");
const prefix = join(home, "npm-global");
const LEAK = "sk-live-should-never-leak-0123456789";

const sh = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
};

/** `claude` as the native installer leaves it; `claude install <v>` adds a version and moves the launcher. 6.6.6 breaks. */
const claudeScript = (version: string) => `V="${version}"
if [ "$1" = "--version" ]; then echo "$V (Claude Code)"; exit 0; fi
if [ "$1" = "install" ]; then
  T="$2"; D="$HOME/.local/share/claude/versions"
  echo "Installing Claude Code native build $T..."
  echo "debug token=supersecret-value key=[$FAKE_API_KEY]"
  if [ "$T" = "6.6.6" ]; then printf '#!/bin/sh\\nexit 1\\n' > "$D/$T"; else sed "s/^V=\\".*\\"/V=\\"$T\\"/" "$0" > "$D/$T"; fi
  chmod +x "$D/$T"; ln -sfn "$D/$T" "$HOME/.local/bin/claude"
  echo "Claude Code successfully installed!"; exit 0
fi
exit 2
`;
const codexScript = (version: string) => `if [ "$1" = "--version" ]; then echo "codex-cli ${version}"; exit 0; fi\nexit 2\n`;
/** npm install --global --prefix P --no-fund --no-audit @openai/codex@V */
const npmScript = `P=""; PKG=""
while [ $# -gt 0 ]; do case "$1" in --prefix) P="$2"; shift;; @openai/codex@*) PKG="$1";; esac; shift; done
V="\${PKG#@openai/codex@}"
F="$P/lib/node_modules/@openai/codex/bin/codex.js"
mkdir -p "$(dirname "$F")" "$P/bin"
printf '#!/bin/sh\\nif [ "$1" = "--version" ]; then echo "codex-cli %s"; exit 0; fi\\nexit 2\\n' "$V" > "$F"; chmod +x "$F"
ln -sfn "$F" "$P/bin/codex"
echo "changed 1 package in 1s"
`;
const grokInstaller = `#!/bin/bash
V="\${1:-2.0.0}"; B="$HOME/.grok/bin"; mkdir -p "$B"
printf '#!/bin/sh\\nif [ "$1" = "--version" ]; then echo "grok %s (fake)"; exit 0; fi\\nexit 2\\n' "$V" > "$B/grok-$V"; chmod +x "$B/grok-$V"
ln -sfn "grok-$V" "$B/grok"
echo "Grok $V installed to $B"
`;

let registryDown = false;
const registry = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/latest/claude") return new Response("1.1.0\n");
    if (path === "/latest/codex") return registryDown ? new Response("down", { status: 503 }) : Response.json({ latest: "0.170.0", next: "0.171.0-alpha.1" });
    if (path === "/latest/grok") return new Response("2.0.0");
    if (path === "/installers/grok/install.sh") return new Response(grokInstaller);
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${registry.port}`;

let gw: TestGateway;
let child: ReturnType<typeof Bun.spawn> | undefined;
let output = Promise.resolve("");
let realId = "";

const workerOf = async (id: string) => (await gw.api.getOverview({})).workers.find((w) => w.id === id);
const tool = (worker: ui.Worker | undefined, provider: Provider) => worker?.cliTools.find((t) => t.tool?.provider === provider);
const settled = (provider: Provider) => (w: ui.Worker | undefined) => {
  const state = tool(w, provider)?.tool?.install?.state;
  return state === "succeeded" || state === "failed";
};

describe.skipIf(!dockerAvailable)("provider CLIs (gateway + real worker + fake CLIs and registry)", () => {
  beforeAll(async () => {
    // Claude: native installer layout. Codex: npm global under its own prefix (with its npm). Grok: absent.
    sh(join(home, ".local/share/claude/versions/1.0.0"), claudeScript("1.0.0"));
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    symlinkSync(join(home, ".local/share/claude/versions/1.0.0"), join(home, ".local/bin/claude"));
    sh(join(prefix, "lib/node_modules/@openai/codex/bin/codex.js"), codexScript("0.164.0"));
    mkdirSync(join(prefix, "bin"), { recursive: true });
    symlinkSync(join(prefix, "lib/node_modules/@openai/codex/bin/codex.js"), join(prefix, "bin/codex"));
    sh(join(prefix, "bin/npm"), npmScript);
    mkdirSync(join(root, "tmp"));

    gw = await startTestGateway({
      cliLatest: { sources: { claude: `${base}/latest/claude`, codex: `${base}/latest/codex`, grok: `${base}/latest/grok` }, allowHttpForTests: true },
      worker: { hello: { capabilities: ["cli_install"] } },
    });
    const added = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: "real", ownerUserId: gw.userId })));
    realId = added.workerId;
    // Harness runtimes stay off: this worker only reports and installs CLIs.
    await gw.runtime.runPromise(GatewayStore.use((s) => s.setWorkerConfig(realId, { claude: { enabled: false }, codex: { enabled: false }, grok: { enabled: false } }, gw.userId)));
    const config = join(root, "worker.json");
    writeFileSync(config, JSON.stringify({ gateway_url: gw.grpcUrl, worker_id: realId, credential: added.credential, data_dir: join(root, "data") }), { mode: 0o600 });
    child = Bun.spawn([process.execPath, "apps/worker/src/main.ts", "--config", config], {
      env: {
        HOME: home, PATH: `${join(prefix, "bin")}:/usr/bin:/bin`, TMPDIR: join(root, "tmp"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
        CANOPY_CLI_INSTALLER_BASE_URL: `${base}/installers`, FAKE_API_KEY: LEAK,
      },
      stdout: "pipe", stderr: "pipe",
    });
    output = Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()]).then((parts) => parts.join(""));
    await eventually(() => workerOf(realId), (w) => (w?.cliTools.length ?? 0) === 3, 20_000);
  }, 60_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await child?.exited;
    if (process.env["CANOPY_TEST_LOG"] === "1") console.error(await output);
    await gw?.close();
    registry.stop(true);
  });

  test("discovery is reported over the link: path, version and install method per CLI", async () => {
    const worker = await workerOf(realId);
    expect(worker?.arch).toBe(process.arch);
    const claude = tool(worker, Provider.CLAUDE)!.tool!;
    expect(claude).toMatchObject({ method: CliInstallMethod.NATIVE, version: "1.0.0", path: join(home, ".local/bin/claude"), installable: true });
    expect(claude.resolvedPath).toEndWith(".local/share/claude/versions/1.0.0");
    expect(tool(worker, Provider.CODEX)!.tool).toMatchObject({ method: CliInstallMethod.NPM, version: "0.164.0", path: join(prefix, "bin/codex"), installable: true });
    expect(tool(worker, Provider.GROK)!.tool).toMatchObject({ method: CliInstallMethod.NOT_INSTALLED, version: "", installable: true });
  });

  test("latest versions from the registry: update available, install offered; a failing source says so", async () => {
    const checked = await gw.api.checkCliUpdates({});
    expect(checked.latest.map((l) => [Provider[l.provider], l.version, l.error])).toEqual([["CLAUDE", "1.1.0", ""], ["CODEX", "0.170.0", ""], ["GROK", "2.0.0", ""]]);
    const worker = await workerOf(realId);
    expect(tool(worker, Provider.CLAUDE)).toMatchObject({ updateAvailable: true, action: "update", blockedReason: "" });
    expect(tool(worker, Provider.CODEX)).toMatchObject({ updateAvailable: true, action: "update" });
    expect(tool(worker, Provider.GROK)).toMatchObject({ updateAvailable: false, action: "install" });

    registryDown = true;
    const down = await gw.api.checkCliUpdates({ workerId: realId });
    registryDown = false;
    const codex = down.latest.find((l) => l.provider === Provider.CODEX)!;
    // The last known version stays; the error is shown, nothing blocks.
    expect(codex.version).toBe("0.170.0");
    expect(codex.error).toContain("503");
    await gw.api.checkCliUpdates({});
  });

  test("native Claude updates with `claude install`; output is redacted and secrets never reach the installer", async () => {
    const started = await gw.api.installCli({ workerId: realId, provider: Provider.CLAUDE });
    expect(started.started).toEqual([realId]);
    const worker = await eventually(() => workerOf(realId), settled(Provider.CLAUDE), 30_000);
    const claude = tool(worker, Provider.CLAUDE)!;
    expect(claude.tool).toMatchObject({ version: "1.1.0", method: CliInstallMethod.NATIVE, install: { state: "succeeded", targetVersion: "1.1.0", previousVersion: "1.0.0" } });
    expect(claude.updateAvailable).toBe(false);
    expect(claude.action).toBe("");
    const log = claude.log.join("\n");
    expect(log).toContain("successfully installed");
    expect(log).toContain("token=***");
    expect(log).not.toContain("supersecret");
    expect(log).not.toContain(LEAK);
    expect(log).toContain("key=[]");
  });

  test("Codex as an npm global package: \"Update all\" runs npm with the same prefix; workers without an update are left out", async () => {
    const started = await gw.api.installCli({ provider: Provider.CODEX, allWorkers: true });
    // The scripted laptop reported no CLIs: not a candidate.
    expect(started.started).toEqual([realId]);
    const worker = await eventually(() => workerOf(realId), settled(Provider.CODEX), 30_000);
    expect(tool(worker, Provider.CODEX)!.tool).toMatchObject({ version: "0.170.0", method: CliInstallMethod.NPM, path: join(prefix, "bin/codex"), install: { state: "succeeded" } });
    expect(tool(worker, Provider.CODEX)!.log.join("\n")).toContain(`--prefix ${prefix}`);
  });

  test("a missing Grok installs with the official installer into the home directory", async () => {
    await gw.api.installCli({ workerId: realId, provider: Provider.GROK });
    const worker = await eventually(() => workerOf(realId), settled(Provider.GROK), 30_000);
    expect(tool(worker, Provider.GROK)!.tool).toMatchObject({ version: "2.0.0", method: CliInstallMethod.NATIVE, path: join(home, ".grok/bin/grok"), install: { state: "succeeded" } });
  });

  test("a failed install reports the error and leaves the previous CLI in use", async () => {
    await gw.api.installCli({ workerId: realId, provider: Provider.CLAUDE, version: "6.6.6" });
    const worker = await eventually(() => workerOf(realId), (w) => tool(w, Provider.CLAUDE)?.tool?.install?.targetVersion === "6.6.6" && settled(Provider.CLAUDE)(w), 30_000);
    const claude = tool(worker, Provider.CLAUDE)!.tool!;
    expect(claude.install).toMatchObject({ state: "failed" });
    expect(claude.install!.error).toContain("1.1.0 is still in use");
    expect(claude.version).toBe("1.1.0");
    const run = Bun.spawnSync([join(home, ".local/bin/claude"), "--version"]);
    expect(run.stdout.toString()).toContain("1.1.0");
    expect(await failure(gw.api.installCli({ workerId: realId, provider: Provider.CLAUDE, version: "1.2.3; rm -rf ~" }))).toContain("not a version");
  });

  test("Homebrew and container installs get no action, and the gateway refuses them", async () => {
    // Codex from a Homebrew Cellar (configured path).
    const cellar = join(root, "brew/Cellar/codex/0.170.0/bin/codex");
    sh(cellar, codexScript("0.170.0"));
    await gw.runtime.runPromise(GatewayStore.use((s) => s.setWorkerConfig(realId, { claude: { enabled: false }, codex: { enabled: false, executablePath: cellar }, grok: { enabled: false } }, gw.userId)));
    gw.core.link.pushConfig(realId, (await gw.runtime.runPromise(GatewayStore.use((s) => s.workerConfig(realId))))!);
    await gw.api.checkCliUpdates({ workerId: realId });
    const worker = await eventually(() => workerOf(realId), (w) => tool(w, Provider.CODEX)?.tool?.method === CliInstallMethod.HOMEBREW, 20_000);
    expect(tool(worker, Provider.CODEX)).toMatchObject({ action: "", managedBy: "Homebrew", tool: { installable: false, manualCommand: "brew upgrade codex" } });
    const refused = await failure(gw.api.installCli({ workerId: realId, provider: Provider.CODEX, version: "0.171.0" }));
    expect(refused).toContain("managed by Homebrew");
    expect(refused).toContain("brew upgrade codex");

    // A container worker reports its CLIs as part of the image; even a report claiming a recipe gets none.
    gw.worker.link.send({ case: "cliTools", value: { os: "linux", arch: "x64", tools: [{ provider: Provider.CLAUDE, method: CliInstallMethod.DOCKER, version: "1.0.0", path: "/usr/local/bin/claude", installable: true }] } });
    const laptop = await eventually(() => workerOf(gw.workerId), (w) => (w?.cliTools.length ?? 0) > 0);
    expect(tool(laptop, Provider.CLAUDE)).toMatchObject({ action: "", managedBy: "the image" });
    expect(await failure(gw.api.installCli({ workerId: gw.workerId, provider: Provider.CLAUDE }))).toContain("managed by the image");
    expect(gw.worker.commands.some((c) => c.case === "installCli")).toBe(false);
  });

  test("a provider with running turns is refused until they finish", async () => {
    const laptop: ScriptedWorker = gw.worker;
    laptop.link.send({ case: "cliTools", value: { os: "linux", arch: "x64", tools: [{ provider: Provider.CODEX, method: CliInstallMethod.NPM, version: "0.164.0", path: "/home/test/.npm/bin/codex", installable: true }] } });
    await eventually(() => workerOf(gw.workerId), (w) => tool(w, Provider.CODEX)?.action === "update");
    const projectId = (await gw.api.createProject({ name: "CLI" })).project!.id;
    const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/cli", label: "" })).workspace!.id;
    const thread = (await gw.api.createThread({ projectId, workspaceId, title: "busy", provider: Provider.CODEX, permissionMode: PermissionMode.ASK, clientRequestId: "cli-busy" })).thread!;
    laptop.holdTurns = true;
    await gw.api.sendMessage({ threadId: thread.id, text: "work", clientRequestId: "cli-m1" });
    const busy = await eventually(() => workerOf(gw.workerId), (w) => (tool(w, Provider.CODEX)?.runningTurns ?? 0) > 0);
    expect(tool(busy, Provider.CODEX)!.blockedReason).toBe("Waiting for 1 running turn to finish");
    expect(await failure(gw.api.installCli({ workerId: gw.workerId, provider: Provider.CODEX }))).toContain("1 running turn");
    expect(laptop.commands.some((c) => c.case === "installCli")).toBe(false);

    const turnId = [...laptop.started.keys()].at(-1)!;
    laptop.finish(thread.id, turnId);
    await eventually(() => workerOf(gw.workerId), (w) => tool(w, Provider.CODEX)?.runningTurns === 0);
    await gw.api.installCli({ workerId: gw.workerId, provider: Provider.CODEX });
    const sent = laptop.commands.find((c) => c.case === "installCli");
    expect(sent?.case === "installCli" && [sent.value.provider, sent.value.version]).toEqual([Provider.CODEX, "0.170.0"]);
  });

  test("another owner's worker cannot be touched", async () => {
    const other = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@localhost", "Other")));
    const theirs = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: "theirs", ownerUserId: other })));
    expect(await workerOf(theirs.workerId)).toBeUndefined();
    expect(await failure(gw.api.installCli({ workerId: theirs.workerId, provider: Provider.CLAUDE, version: "1.1.0" }))).toContain("worker not found");
    expect(await failure(gw.api.checkCliUpdates({ workerId: theirs.workerId }))).toContain("worker not found");
    // Every install the owner started is audited; none on the other owner's worker.
    const audit = await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ target_id: string }>`SELECT target_id FROM audit_log WHERE action = 'worker.cli.install'`;
    }));
    expect(audit.length).toBe(5);
    expect(audit.map((a) => a.target_id)).not.toContain(theirs.workerId);
    expect(readFileSync(join(home, ".local/bin/claude"), "utf8")).toContain('V="1.1.0"');
  });
});
