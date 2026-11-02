/**
 * A profile's environment variables reach its harness process (docs/worker-config.md, "Zmienne środowiskowe
 * profilu"): WorkerHost with a stand-in `codex` that only answers `initialize` and records its environment.
 * Profiles without variables share one app-server; a profile with variables gets its own; a change restarts only
 * the processes whose settings changed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Provider, ProviderProfileKind, WorkerConfigSchema, type WorkerConfig } from "@open-agents/contracts";
import { tempDir } from "@open-agents/testing";
import { Journal } from "@open-agents/worker/journal";
import { WorkerHost } from "@open-agents/worker/runtime";
import { ManagedRuntime } from "effect";

const dir = tempDir("oa-profile-env-");
const root = join(dir, "repos");
const log = join(dir, "codex-processes.jsonl");
const codex = join(dir, "codex");
mkdirSync(root, { recursive: true });

// Answers --version and the app-server handshake; writes one line per app-server process: pid, its probe variables.
writeFileSync(
  codex,
  `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("codex-cli 0.164.0"); process.exit(0); }
const env = process.env;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, probe: env.PROFILE_PROBE ?? null, token: env.TEAM_TOKEN ?? null, keys: Object.keys(env).filter((k) => k.startsWith("OPENAGENTS_")).sort() }) + "\\n");
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const result = msg.method === "initialize" ? { userAgent: "fake/0.164.0" } : undefined;
    process.stdout.write(JSON.stringify(result ? { id: msg.id, result } : { id: msg.id, error: { code: -32601, message: "not in the fake" } }) + "\\n");
  }
}
`,
);
chmodSync(codex, 0o755);

let runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
let host: WorkerHost;
let version = 0n;

const processes = () =>
  existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { pid: number; probe: string | null; token: string | null; keys: string[] })
    : [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const config = (profiles: NonNullable<MessageInitShape<typeof WorkerConfigSchema>["profiles"]>): WorkerConfig =>
  create(WorkerConfigSchema, {
    version: ++version,
    allowedRoots: [root],
    claude: { enabled: false },
    codex: { enabled: true, executablePath: codex },
    profiles,
  });
const proxy = { id: "team", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:9", apiKey: "k", providers: [Provider.CODEX] };

beforeAll(() => {
  runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
  host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "test", deviceHomes: { claude: join(dir, "claude"), codex: join(dir, "codex-device") } });
});

afterAll(async () => {
  await host.close();
  await runtime.dispose();
});

describe("profile environment on the Codex app-server", () => {
  test("profiles without variables share one process", async () => {
    const report = await host.applyConfig(config([proxy]));
    expect(report.applied).toBe(true);
    const started = processes();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ probe: null, keys: ["OPENAGENTS_TEAM_API_KEY"] });
  });

  test("a profile with variables gets its own process with them; the shared one keeps running", async () => {
    const [shared] = processes();
    await host.applyConfig(config([{ ...proxy, env: [{ name: "PROFILE_PROBE", value: "probe-7" }, { name: "TEAM_TOKEN", value: "t0k", secret: true }] }]));
    const started = processes();
    expect(started).toHaveLength(3); // the shared one again (its profile left it), and the profile's own
    expect(alive(shared!.pid)).toBe(false);
    const own = started.find((p) => p.probe === "probe-7");
    expect(own).toMatchObject({ token: "t0k", keys: ["OPENAGENTS_TEAM_API_KEY"] });
    const newShared = started.at(-1)!.probe === null ? started.at(-1)! : started.at(-2)!;
    expect(newShared).toMatchObject({ probe: null, keys: [] });
    expect(alive(own!.pid) && alive(newShared.pid)).toBe(true);
  });

  test("changing only the profile's variables restarts only its process", async () => {
    const before = processes();
    const shared = before.find((p) => p.probe === null && p.keys.length === 0)!;
    await host.applyConfig(config([{ ...proxy, env: [{ name: "PROFILE_PROBE", value: "probe-8" }] }]));
    const after = processes();
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({ probe: "probe-8", token: null });
    expect(alive(shared.pid)).toBe(true);
  });

  test("a variable the worker controls disables the profile instead of reaching the process", async () => {
    const report = await host.applyConfig(config([{ ...proxy, env: [{ name: "CODEX_HOME", value: "/elsewhere" }] }]));
    expect(report.profiles?.find((p) => p.id === "team")).toMatchObject({ available: false });
    expect(JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain("/elsewhere");
    expect(processes().some((p) => p.probe === null && p.keys.length === 0)).toBe(true);
  });
});
