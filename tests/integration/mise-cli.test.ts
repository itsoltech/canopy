/** Real discovery and installation against isolated mise homes; no provider or package manager is downloaded. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { CliInstallMethod, InstallCliSchema, Provider } from "@canopy/contracts";
import { processGovernor } from "@canopy/process-governor";
import { tempDir } from "@canopy/testing";
import { CLIS, deviceCliProbe, discoverCli, type CliSpec } from "../../apps/worker/src/cli-tools/discovery.ts";
import { CliTools } from "../../apps/worker/src/cli-tools/index.ts";
import { eventually } from "./support/gateway.ts";

const root = tempDir("canopy-mise-cli-");
const cleanups: (() => Promise<void>)[] = [];
let homes = 0;

function executable(path: string, body: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

// Both probes and installers must ignore the worker's project directory.
const homeOnly = '[ "$PWD" = "$HOME" ] || { echo "project directory leaked" >&2; exit 42; }';

const mise = `${homeOnly}
case "$1" in
  which) IFS= read -r target < "$HOME/target-$2"; printf '%s\n' "$target"; exit;;
  ls) [ "$2" = --json ] || exit 43; tool="$4";;
  use) printf '%s\n' "$*" >> "$HOME/calls"; for arg in "$@"; do tool="$arg"; done; tool="\${tool%@*}";;
  *) exit 44;;
esac
case "$tool" in
  claude|claude-code|npm:@anthropic-ai/claude-code) name=claude;;
  codex|npm:@openai/codex) name=codex;;
  grok|npm:@xai-official/grok) name=grok;;
  *) exit 45;;
esac
if [ "$1" = ls ]; then
  if [ "$3" = --current ] && [ -f "$HOME/current-json-$name" ]; then /bin/cat "$HOME/current-json-$name"; exit; fi
  if [ -f "$HOME/global-json-$name" ]; then /bin/cat "$HOME/global-json-$name"; else
    IFS= read -r version < "$HOME/global-$name"
    printf '[{"version":"%s","installed":true,"source":{"type":"mise.toml","path":"%s/.config/mise/config.toml"}}]\n' "$version" "$HOME"
  fi
  exit
fi
/bin/mkdir "$HOME/config-lock" 2>/dev/null || { echo overlap > "$HOME/overlap"; exit 46; }
trap '/bin/rmdir "$HOME/config-lock"' EXIT
version="\${arg##*@}"
[ "$version" != latest ] || version=2.0.0
echo started > "$HOME/started-$name-$version"
while [ -f "$HOME/hold-$name-$version" ] && [ ! -f "$HOME/release-$name-$version" ]; do /bin/sleep 0.01; done
# A failed download leaves the old selection untouched.
[ "$version" != 4.0.0 ] || { echo "download failed" >&2; exit 9; }
IFS= read -r owner < "$HOME/owner-$name"
IFS= read -r suffix < "$HOME/suffix-$name"
target="$MISE_DATA_DIR/installs/$owner/$version/$suffix"
[ -x "$target" ] || exit 47
printf '%s\n' "$target" > "$HOME/target-$name.new"
/bin/mv "$HOME/target-$name.new" "$HOME/target-$name"
printf '%s\n' "$version" > "$HOME/global-$name.new"
/bin/mv "$HOME/global-$name.new" "$HOME/global-$name"
echo "Selected $tool@$version"
`;

function device(customData = false) {
  const home = join(root, `home-${++homes}`);
  const data = join(home, customData ? "tools-data" : ".local/share/mise");
  const env = { HOME: home, PATH: `${home}/bin:${data}/shims`, MISE_DATA_DIR: data };
  const configured: Partial<Record<CliSpec["name"], string>> = {};
  const probe = deviceCliProbe({ platform: "linux", home, docker: false, env: () => env });
  const progress: string[] = [];

  const tools = new CliTools({
    dataDir: join(home, "worker"),
    probe,
    env,
    configured: () => configured,
    send: () => {},
    progress: (event) => progress.push(...(event.lines ?? [])),
    busy: () => 0,
    installed: async () => {},
    log: () => {},
  });

  executable(join(home, "bin/mise"), mise);

  const text = (name: string, body: string) => writeFileSync(join(home, name), body);
  const has = (name: string) => existsSync(join(home, name));
  const calls = () => (has("calls") ? readFileSync(join(home, "calls"), "utf8").trim().split("\n") : []);

  const start = (spec: CliSpec, version = "2.0.0") =>
    tools.start(create(InstallCliSchema, { installId: crypto.randomUUID(), provider: spec.provider, version }));

  const entry = async (spec: CliSpec) => (await tools.report()).tools?.find((tool) => tool.provider === spec.provider);

  function add(spec: CliSpec, owner: string) {
    const suffix =
      owner.startsWith("npm-") || owner === "node"
        ? `lib/node_modules/${spec.npm}/bin/${spec.name}`
        : `bin/${spec.name}`;

    const target = (version: string) => join(data, "installs", owner, version, suffix);

    for (const version of ["1.0.0", "2.0.0", "3.0.0"])
      executable(
        target(version),
        version === "3.0.0" ? 'echo "broken target" >&2; exit 7' : `echo '${spec.name} ${version}'`,
      );
    text(`owner-${spec.name}`, owner);
    text(`suffix-${spec.name}`, suffix);
    text(`target-${spec.name}`, target("1.0.0"));
    text(`global-${spec.name}`, "1.0.0");
    const launcher = `${homeOnly}\nIFS= read -r target < "$HOME/target-${spec.name}"\nexec "$target" "$@"`;
    const shim = join(data, "shims", spec.name);
    executable(shim, launcher);
    const latest = join(data, "installs", owner, "latest", suffix);
    executable(latest, launcher);

    return { shim, latest, previous: target("1.0.0") };
  }

  cleanups.push(async () => {
    for (const spec of CLIS)
      for (const version of ["1.0.0", "2.0.0", "3.0.0"]) text(`release-${spec.name}-${version}`, "");
    await Promise.all(CLIS.map((spec) => tools.settled(spec.provider)));
  });

  return { home, data, probe, tools, configured, progress, text, has, calls, start, entry, add };
}

beforeEach(() => processGovernor.invalidate());

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const codex = CLIS.find((spec) => spec.name === "codex")!;
const claude = CLIS.find((spec) => spec.name === "claude")!;

const owners = CLIS.flatMap((spec) => [
  { spec, owner: spec.name, tool: spec.name },
  { spec, owner: `npm-${spec.npm.slice(1).replaceAll("/", "-")}`, tool: `npm:${spec.npm}` },
]);

owners.push({ spec: claude, owner: "claude-code", tool: "claude-code" });

describe("mise global agent CLIs", () => {
  test.each(owners)(
    "$owner: discovers the owner and switches the pinned global version",
    async ({ spec, owner, tool }) => {
      const d = device(true);
      const { shim } = d.add(spec, owner);
      expect(await discoverCli(spec, undefined, d.probe)).toMatchObject({
        method: CliInstallMethod.MISE,
        owner,
        miseGlobal: true,
        path: shim,
        version: "1.0.0",
      });
      expect(await d.entry(spec)).toMatchObject({ installable: true, installResource: "mise:config" });

      await d.start(spec);
      await d.tools.settled(spec.provider);
      expect(await d.entry(spec)).toMatchObject({
        method: CliInstallMethod.MISE,
        path: shim,
        version: "2.0.0",
        install: { state: "succeeded", targetVersion: "2.0.0", previousVersion: "1.0.0" },
      });
      expect(d.calls()).toEqual([`use --global --yes --pin ${tool}@2.0.0`]);
      expect(await d.probe.version(shim)).toEqual({ line: `${spec.name} 2.0.0` });
    },
  );

  test("a configured shim follows an unpinned global update", async () => {
    const d = device();
    const { shim } = d.add(codex, "codex");
    d.configured.codex = shim;
    await d.start(codex, "latest");
    await d.tools.settled(Provider.CODEX);
    expect(await d.entry(codex)).toMatchObject({
      path: shim,
      configuredPath: true,
      version: "2.0.0",
      install: { state: "succeeded", targetVersion: "latest" },
    });
    expect(d.calls()).toEqual(["use --global --yes codex@latest"]);
  });

  test("a broken target rolls back before a second provider may change global config", async () => {
    const d = device(true);
    const { shim } = d.add(claude, "npm-anthropic-ai-claude-code");
    d.add(codex, "codex");
    d.text("hold-claude-3.0.0", "");
    d.text("hold-claude-1.0.0", "");
    await d.start(claude, "3.0.0");
    expect(await eventually(async () => d.has("started-claude-3.0.0"), Boolean)).toBe(true);
    await d.start(codex);
    await expect(d.start(claude)).rejects.toMatchObject({ code: "CLI_INSTALL_RUNNING" });
    expect(await d.entry(codex)).toMatchObject({ install: { state: "running" }, version: "1.0.0" });
    expect(d.has("started-codex-2.0.0")).toBe(false);
    let settled = false;

    const waiting = d.tools.settled(Provider.CLAUDE).then(() => {
      settled = true;
    });

    d.text("release-claude-3.0.0", "");
    expect(await eventually(async () => d.has("started-claude-1.0.0"), Boolean)).toBe(true);
    expect(settled).toBe(false);
    expect(d.has("started-codex-2.0.0")).toBe(false);
    d.text("release-claude-1.0.0", "");
    await waiting;
    await d.tools.settled(Provider.CODEX);

    const failed = await d.entry(claude);
    expect(failed).toMatchObject({ version: "1.0.0", installable: true, install: { state: "failed" } });
    expect(failed?.install?.error).toContain("1.0.0 is still in use");
    expect(await d.probe.version(shim)).toEqual({ line: "claude 1.0.0" });
    expect(await d.entry(codex)).toMatchObject({ version: "2.0.0", install: { state: "succeeded" } });
    expect(d.calls()).toEqual([
      "use --global --yes --pin npm:@anthropic-ai/claude-code@3.0.0",
      "use --global --yes --pin npm:@anthropic-ai/claude-code@1.0.0",
      "use --global --yes --pin codex@2.0.0",
    ]);
    expect(d.has("overlap")).toBe(false);
    expect(d.progress.join("\n")).toContain("Reinstalling 1.0.0");
  });

  test("an installer failure that leaves the previous version working needs no reinstall", async () => {
    const d = device();
    const { shim } = d.add(codex, "codex");
    await d.start(codex, "4.0.0");
    await d.tools.settled(Provider.CODEX);
    const entry = await d.entry(codex);
    expect(entry).toMatchObject({ version: "1.0.0", install: { state: "failed" } });
    expect(entry?.install?.error).toContain("the installer exited with code 9; 1.0.0 is still in use");
    expect(await d.probe.version(shim)).toEqual({ line: "codex 1.0.0" });
    expect(d.calls()).toHaveLength(1);
  });
});

describe("mise installations that require a manual update", () => {
  test.each([
    { type: "mise.toml", path: "/project/mise.toml" },
    { type: "env", path: undefined },
  ])("an active $type override cannot replace the global request", async (source) => {
    const d = device();
    d.add(codex, "codex");
    d.text("current-json-codex", JSON.stringify([{ version: "1.0.0", installed: true, source }]));
    expect(await d.entry(codex)).toMatchObject({ installable: false, version: "1.0.0" });
    await expect(d.start(codex)).rejects.toMatchObject({ code: "CLI_MANAGED_EXTERNALLY" });
    expect(d.calls()).toEqual([]);
  });

  test.each([
    { label: "project-only", json: "[]" },
    {
      label: "multiple global versions",
      json: '[{"version":"1.0.0","installed":true},{"version":"2.0.0","installed":true}]',
    },
    { label: "uninstalled request", json: '[{"version":"1.0.0","installed":false}]' },
    { label: "different global version", json: '[{"version":"2.0.0","installed":true}]' },
    { label: "malformed manager output", json: '{"version":"1.0.0","installed":true}' },
  ])("$label never changes the global selection", async ({ json }) => {
    const d = device();
    d.add(codex, "codex");
    d.text("global-json-codex", json);
    expect(await discoverCli(codex, undefined, d.probe)).toMatchObject({ owner: "codex", miseGlobal: false });
    expect(await d.entry(codex)).toMatchObject({
      method: CliInstallMethod.MISE,
      installable: false,
      manualCommand: "mise upgrade codex",
    });
    await expect(d.start(codex)).rejects.toMatchObject({ code: "CLI_MANAGED_EXTERNALLY" });
    expect(d.calls()).toEqual([]);
  });

  test.each(["unknown-tool", "node"])(
    "owner %s cannot upgrade an unrelated tool or the node runtime",
    async (owner) => {
      const d = device(true);
      const { shim } = d.add(codex, owner);
      expect(await discoverCli(codex, undefined, d.probe)).toMatchObject({ method: CliInstallMethod.MISE, owner });
      expect(await d.entry(codex)).toMatchObject({ installable: false, version: "1.0.0" });
      await expect(d.start(codex)).rejects.toMatchObject({ code: "CLI_MANAGED_EXTERNALLY" });
      expect(await d.probe.version(shim)).toEqual({ line: "codex 1.0.0" });
      expect(d.calls()).toEqual([]);
    },
  );

  test.each(["previous", "latest"] as const)("a direct %s path cannot change the global version", async (key) => {
    const d = device();
    const path = d.add(codex, "codex")[key];
    d.configured.codex = path;
    expect(await discoverCli(codex, path, d.probe)).toMatchObject({ miseGlobal: true, owner: "codex" });
    expect(await d.entry(codex)).toMatchObject({ installable: false, configuredPath: true, version: "1.0.0" });
    await expect(d.start(codex)).rejects.toMatchObject({ code: "CLI_MANAGED_EXTERNALLY" });
    expect(d.calls()).toEqual([]);
  });

  test("a working mise shim stays manual when the manager executable is missing", async () => {
    const d = device();
    const { shim } = d.add(codex, "codex");
    rmSync(join(d.home, "bin/mise"));
    expect(await d.entry(codex)).toMatchObject({ method: CliInstallMethod.MISE, installable: false, version: "1.0.0" });
    await expect(d.start(codex)).rejects.toMatchObject({ code: "CLI_MANAGED_EXTERNALLY" });
    expect(await d.probe.version(shim)).toEqual({ line: "codex 1.0.0" });
    expect(d.calls()).toEqual([]);
  });
});
