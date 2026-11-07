import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { ImportScanSchema } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { tempDirs } from "@canopy/testing";
import { installFixtureHome, treeFingerprint } from "./fixtures/install.ts";
import { MASK } from "./masking.ts";
import { WorkerImport } from "./service.ts";
import { resolveSourceKey, SourceKeyError } from "./source-key.ts";

/** Harness adapter test (docs/import.md, "Testy"): scans of real-format CLI homes and their edge cases. */

const temp = tempDirs();
const CANARY = "sk-ant-api03-CANARYcanaryCANARYcanary0123456789";

function fixture() {
  const root = temp("canopy-import-scan-");
  const home = join(root, "home");
  installFixtureHome(home);

  const service = new WorkerImport({
    dataDir: join(root, "data"),
    homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
    config: () => undefined,
  });

  return { root, home, service };
}

test("lists sessions of all three CLIs with metadata only and leaves the homes untouched", async () => {
  const { home, service } = fixture();
  const before = treeFingerprint(home);
  const scan = await service.scan([]);

  expect(treeFingerprint(home)).toBe(before);
  expect(scan.truncated).toBe(false);
  expect(scan.skipped).toBe(0);
  expect(scan.roots?.map((r) => r.agentCli)).toEqual(["claude", "codex", "grok"]);
  const by = (cli: string) => (scan.threads ?? []).filter((t) => t.agentCli === cli);
  expect(by("claude")).toHaveLength(2);
  expect(by("codex")).toHaveLength(2);
  expect(by("grok")).toHaveLength(1);

  const main = by("claude").find((t) => t.cwd === join(home, "project"))!;
  expect(main).toMatchObject({ cwdExists: true, format: "supported", origin: "exec", cliVersion: "2.1.308" });
  expect(main.preview || main.title).toBeTruthy();
  expect(main.turns).toBeGreaterThanOrEqual(4);

  const codex = by("codex").find((t) => t.cwd === join(home, "project"))!;
  expect(codex).toMatchObject({ origin: "exec", format: "supported", cliVersion: "0.164.0", turns: 2 });
  expect(codex.preview).toContain("FIXTURE_TOOL");

  const grok = by("grok")[0]!;
  expect(grok).toMatchObject({ cwd: join(home, "project"), cwdExists: true, format: "supported", turns: 2 });

  // Metadata only: no answer, tool output or reasoning leaves the worker during a scan.
  const sent = toJsonString(ImportScanSchema, create(ImportScanSchema, scan));

  for (const marker of ["FIXTURE_TOOL_OUTPUT", "Fixture reasoning", "FIXTURE_SUBTASK"])
    expect(sent).not.toContain(marker);
  // Grok names its sessions with the model; that title is metadata the CLI shows itself.
  expect(grok.title).toBe("FIXTURE_ANSWER none");
});

test("masks secrets the worker can see and token formats in titles and previews", async () => {
  const { home, service } = fixture();
  writeFileSync(
    join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "codex-device-token-CANARY-42" } }),
  );
  const project = join(home, ".claude", "projects", home.replace(/[^a-zA-Z0-9]/g, "-") + "-project");
  const session = readdirSync(project).find((f) => f.endsWith(".jsonl"))!;
  const id = crypto.randomUUID();
  writeFileSync(
    join(project, `${id}.jsonl`),
    `${JSON.stringify({ type: "user", uuid: "u1", sessionId: id, cwd: join(home, "project"), timestamp: new Date().toISOString(), message: { role: "user", content: `deploy with ${CANARY} and codex-device-token-CANARY-42` } })}\n`,
  );
  const scan = await service.scan(["claude"]);
  const planted = scan.threads!.find((t) => t.nativeId === id)!;

  expect(planted.preview).not.toContain(CANARY);
  expect(planted.preview).not.toContain("codex-device-token-CANARY-42");
  expect(planted.preview).toContain(MASK);
  expect(planted.flaggedSecrets).toBe(2);
  expect(scan.threads!.find((t) => `${t.nativeId}.jsonl` === session)!.flaggedSecrets).toBe(0);
});

test("synthetic edge cases: broken lines, empty files, newer versions, missing directories, symlinks", async () => {
  const { root, home, service } = fixture();
  const dir = join(home, ".claude", "projects", "-edge");
  mkdirSync(dir, { recursive: true });

  const line = (id: string, extra: JsonObject) =>
    `${JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: id, timestamp: "2026-01-02T03:04:05Z", message: { role: "user", content: "hello" }, ...extra })}\n`;

  const broken = crypto.randomUUID();
  writeFileSync(
    join(dir, `${broken}.jsonl`),
    `{"type":"user"\n${line(broken, { cwd: join(home, "gone"), version: "2.1.1" })}not json\n{"type":"assistant","message":`,
  );
  const newer = crypto.randomUUID();
  writeFileSync(join(dir, `${newer}.jsonl`), line(newer, { cwd: join(home, "project"), version: "2.9.0" }));
  const empty = crypto.randomUUID();
  writeFileSync(join(dir, `${empty}.jsonl`), "");
  // A session file that is a symlink to a file outside the root is not listed.
  writeFileSync(join(root, "outside.jsonl"), line("outside", { cwd: home }));
  symlinkSync(join(root, "outside.jsonl"), join(dir, `${crypto.randomUUID()}.jsonl`));
  // A Grok directory with only a summary (seen on real machines) is empty.
  const grokEmpty = join(home, ".grok", "sessions", encodeURIComponent(join(home, "project")), crypto.randomUUID());
  mkdirSync(grokEmpty, { recursive: true });
  writeFileSync(join(grokEmpty, "summary.json"), JSON.stringify({ created_at: "2026-01-01T00:00:00Z" }));
  appendFileSync(join(home, ".codex", "session_index.jsonl"), "{broken\n");

  const scan = await service.scan([]);
  const find = (id: string) => scan.threads!.find((t) => t.nativeId === id);

  expect(find(broken)).toMatchObject({ cwdExists: false, format: "supported", turns: 1 });
  expect(find(newer)?.format).toBe("newer");
  expect(find(empty)?.format).toBe("empty");
  expect(find("outside")).toBeUndefined();
  expect(scan.threads!.filter((t) => t.nativeId === "outside" || t.cwd === home)).toHaveLength(0);
  expect(find(grokEmpty.split("/").at(-1)!)?.format).toBe("empty");
  expect(scan.skipped).toBe(0);
});

test("source keys resolve only inside this worker's roots", async () => {
  const { root, home, service } = fixture();
  const scan = await service.scan(["claude"]);
  const { roots } = service.roots(["claude"]);
  const key = scan.threads![0]!.sourceKey!;
  const resolved = resolveSourceKey(service.key, roots, key, "file");
  expect(resolved.path.startsWith(join(home, ".claude"))).toBe(true);

  const [rootId, , mac] = key.split(".");
  const forge = (rel: string, signature = mac) => `${rootId}.${Buffer.from(rel).toString("base64url")}.${signature}`;

  const refused = (sourceKey: string, kind: "file" | "directory" = "file") =>
    expect(() => resolveSourceKey(service.key, roots, sourceKey, kind)).toThrow(SourceKeyError);

  refused(forge("../../etc/passwd"));
  refused(forge("/etc/passwd"));
  refused(`${key}x`);
  refused(key, "directory");

  // Another worker's key (another HMAC key) is not valid here.
  const other = new WorkerImport({
    dataDir: join(root, "other-data"),
    homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
    config: () => undefined,
  });

  expect(() => resolveSourceKey(other.key, other.roots(["claude"]).roots, key, "file")).toThrow(SourceKeyError);
  // A symlink planted after the scan, under a signed path, is refused.
  const projects = join(home, ".claude", "projects");
  symlinkSync(root, join(projects, "escape"));
  const { signSourceKey } = await import("./source-key.ts");
  refused(signSourceKey(service.key, roots[0]!, join(projects, "escape", "outside.jsonl")));
});

test("links below a CLI home are never followed: linked directories, session dirs and companion files", async () => {
  const { root, home, service } = fixture();
  const outside = join(root, "outside");
  mkdirSync(join(outside, "session"), { recursive: true });
  const id = crypto.randomUUID();
  const secretPrompt = "OUTSIDE_CANARY prompt";
  writeFileSync(
    join(outside, `${id}.jsonl`),
    `${JSON.stringify({ type: "user", uuid: "u1", sessionId: id, cwd: home, timestamp: "2026-01-02T03:04:05Z", message: { role: "user", content: secretPrompt } })}\n`,
  );
  writeFileSync(join(outside, "summary.json"), JSON.stringify({ generated_title: "OUTSIDE_CANARY title" }));
  writeFileSync(
    join(outside, "session", "chat_history.jsonl"),
    `${JSON.stringify({ type: "user", prompt_index: 0, content: secretPrompt })}\n`,
  );
  // A whole project directory, a Grok session directory, and one companion file link out of the homes.
  symlinkSync(outside, join(home, ".claude", "projects", "-linked"));
  const group = join(home, ".grok", "sessions", encodeURIComponent(join(home, "project")));

  const grokSession = join(
    group,
    readdirSync(group).find((d) => !d.includes("."))!,
  );

  symlinkSync(join(outside, "session"), join(group, crypto.randomUUID()));
  rmSync(join(grokSession, "summary.json"));
  symlinkSync(join(outside, "summary.json"), join(grokSession, "summary.json"));

  const scan = await service.scan([]);
  const sent = toJsonString(ImportScanSchema, create(ImportScanSchema, scan));
  expect(sent).not.toContain("OUTSIDE_CANARY");
  expect(scan.threads!.some((t) => t.nativeId === id)).toBe(false);
  // The real Grok session is still listed, without the linked summary's title.
  expect(scan.threads!.filter((t) => t.agentCli === "grok")).toHaveLength(1);

  // Reads at the descriptor level: a linked file at a confined place, or a linked ancestor, opens nothing.
  const { openSource, ConfinementError } = await import("./read.ts");
  const claudeRoot = service.roots(["claude"]).roots[0]!.path;
  expect(() => openSource({ root: claudeRoot, path: join(claudeRoot, "projects", "-linked", `${id}.jsonl`) })).toThrow(
    ConfinementError,
  );
  symlinkSync(join(outside, `${id}.jsonl`), join(claudeRoot, "projects", "linked.jsonl"));
  expect(() => openSource({ root: claudeRoot, path: join(claudeRoot, "projects", "linked.jsonl") })).toThrow(
    ConfinementError,
  );
  expect(() => openSource({ root: claudeRoot, path: join(outside, `${id}.jsonl`) })).toThrow(ConfinementError);
});

test("secrets in settings env blocks and Grok settings are masked like login secrets", async () => {
  const { home, service } = fixture();
  const opaque = "opaque-auth-value-CANARY-0042";
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: opaque } }));
  writeFileSync(join(home, ".grok", "settings.json"), JSON.stringify({ api_key: "grok-settings-CANARY-0042" }));
  const project = join(home, ".claude", "projects", home.replace(/[^a-zA-Z0-9]/g, "-") + "-project");
  const id = crypto.randomUUID();
  writeFileSync(
    join(project, `${id}.jsonl`),
    `${JSON.stringify({ type: "user", uuid: "u1", sessionId: id, cwd: join(home, "project"), timestamp: new Date().toISOString(), message: { role: "user", content: `use ${opaque} and grok-settings-CANARY-0042` } })}\n`,
  );
  const planted = (await service.scan([])).threads!.find((t) => t.nativeId === id)!;

  expect(planted.preview).not.toContain("CANARY");
  expect(planted.flaggedSecrets).toBe(2);
});

test("a FIFO at a name the scan reads does not hold the worker", async () => {
  const { home, service } = fixture();
  const project = join(home, ".claude", "projects", home.replace(/[^a-zA-Z0-9]/g, "-") + "-project");
  const fifo = join(project, `${crypto.randomUUID()}.jsonl`);
  Bun.spawnSync(["mkfifo", fifo]);
  Bun.spawnSync(["mkfifo", join(home, ".codex", "session_index.jsonl.fifo")]);
  Bun.spawnSync(["mkfifo", join(home, ".claude", ".credentials.json")]);
  const { openSource, ConfinementError } = await import("./read.ts");
  const root = service.roots(["claude"]).roots[0]!.path;

  expect(() => openSource({ root, path: fifo })).toThrow(ConfinementError);
  const scan = await service.scan([]);
  expect(scan.threads!.some((t) => fifo.endsWith(`${t.nativeId}.jsonl`))).toBe(false);
}, 10_000);

test("a known secret is found in the form JSON text gives it, also inside other text", async () => {
  const { Masker, maskText } = await import("./masking.ts");
  const secret = 'es\\cap"ed-CANARY-0042';
  const masker = new Masker([secret]);
  const inJson = JSON.stringify({ token: secret });
  const inCommand = `printf '%s' '${inJson}' > config.json`;
  const twice = JSON.stringify(inCommand);

  for (const text of [secret, inJson, inCommand, twice]) expect(maskText(text, masker)).not.toContain("CANARY");
});
