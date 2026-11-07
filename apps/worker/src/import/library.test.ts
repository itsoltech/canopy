import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { ImportScanSchema, ReadImportLibraryItemSchema, ReadImportSecretSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { installFixtureHome, installLibraryFixture, treeFingerprint } from "./fixtures/install.ts";
import { URL_BOUNDARIES } from "./fixtures/url-boundaries.ts";
import { readImportLibraryItem } from "./library-read.ts";
import { readImportSecret } from "./library-secret.ts";
import { WorkerImport } from "./service.ts";
import { signSourceKey } from "./source-key.ts";

/**
 * Settings and library of the CLI homes (docs/import.md, "Ustawienia i biblioteka"): what the scan lists, how values
 * map to Canopy, what stays out and why, and that a key reads only the fixed library places, masked.
 */

const temp = tempDirs();

function setup() {
  const root = temp("canopy-import-library-");
  const home = join(root, "home");
  installFixtureHome(home);
  installLibraryFixture(home);

  const service = new WorkerImport({
    dataDir: join(root, "data"),
    homes: () => ({
      claude: join(home, ".claude"),
      codex: join(home, ".codex"),
      grok: join(home, ".grok"),
      agents: join(home, ".agents"),
      claudeAccount: home,
    }),
    config: () => undefined,
  });

  return { home, service };
}

const read = (service: WorkerImport, sourceKey: string, digest = "") =>
  readImportLibraryItem(service, create(ReadImportLibraryItemSchema, { sourceKey, digest }));

test("settings map to Canopy defaults; hooks, rules, logins and effort are listed with their reason", async () => {
  const { service, home } = setup();
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  const before = [".claude", ".codex", ".grok"].map((d) => treeFingerprint(join(home, d)));
  const { library } = await service.scan([]);
  const of = (cli: string, name: string) => library.find((i) => i.agentCli === cli && i.name === name);

  expect(of("claude", "model")).toMatchObject({ kind: "setting", value: "opus", reason: "" });
  expect(of("claude", "permissions")).toMatchObject({ value: "accept_edits", detail: "acceptEdits" });
  expect(of("claude", "effort")?.reason).toContain("no default effort");
  expect(of("claude", "Hooks")?.reason).toContain("run commands");
  expect(of("claude", "Status line")?.reason).toBeTruthy();
  expect(of("claude", "Permission rules")?.reason).toBeTruthy();
  expect(of("codex", "model")).toMatchObject({ value: "gpt-fixture" });
  // workspace-write with on-request approvals: edits run, everything else asks (never Full auto).
  expect(of("codex", "permissions")).toMatchObject({ value: "accept_edits" });
  expect(of("codex", "Notify")?.reason).toBeTruthy();
  expect(of("codex", "Login")?.reason).toContain("provider instance");
  // Not a setting: the UI theme stays where it is.
  expect(library.some((i) => i.name === "theme")).toBe(false);
  // Settings and logins carry no values beyond names and modes.
  expect(library.every((i) => !i.value || /^[a-z0-9_.-]+$/i.test(i.value))).toBe(true);

  expect(of("claude", "CLAUDE.md")).toMatchObject({ kind: "instruction", reason: "" });
  expect(of("claude", "CLAUDE.md")?.warnings).toEqual(["Canopy doesn't follow @ imports in this file."]);
  expect(of("codex", "AGENTS.md")).toMatchObject({ kind: "instruction", reason: "" });
  expect(of("grok", "AGENTS.md")?.reason).toContain("Claude and Codex");
  expect([".claude", ".codex", ".grok"].map((d) => treeFingerprint(join(home, d)))).toEqual(before);
});

test("the active Codex profile wins, AGENTS.override.md takes AGENTS.md's place, Full access maps to nothing", async () => {
  const { service, home } = setup();
  writeFileSync(
    join(home, ".codex", "config.toml"),
    'profile = "review"\n[profiles.review]\nmodel = "gpt-fixture-mini"\nsandbox_mode = "read-only"\n',
  );
  writeFileSync(join(home, ".codex", "AGENTS.override.md"), "Override\n");
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
  );
  const { library } = await service.scan([]);
  const of = (cli: string, name: string) => library.find((i) => i.agentCli === cli && i.name === name);

  expect(of("codex", "model")?.value).toBe("gpt-fixture-mini");
  // A read-only sandbox with Codex's default approvals still asks before it escalates.
  expect(of("codex", "permissions")?.value).toBe("ask");
  expect(of("codex", "AGENTS.override.md")?.reason).toBe("");
  expect(of("codex", "AGENTS.md")?.reason).toContain("AGENTS.override.md takes its place");
  expect(of("claude", "permissions")).toMatchObject({ value: "", detail: "bypassPermissions" });
  expect(of("claude", "permissions")?.reason).toContain("never sets Full access");

  writeFileSync(join(home, ".codex", "config.toml"), 'sandbox_mode = "danger-full-access"\n');
  const danger = (await service.scan(["codex"])).library.find((i) => i.name === "permissions");
  expect(danger).toMatchObject({ value: "" });
  expect(danger?.reason).toContain("never sets Full access");
});

test("reading an instruction masks secrets and refuses a changed file, a link, or a place outside the library", async () => {
  const { service, home } = setup();
  const secret = `fixture-${"s".repeat(24)}`;
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: secret } }));
  appendFileSync(join(home, ".claude", "CLAUDE.md"), `Token: ${secret}\n`);
  const scan = await service.scan(["claude"]);
  const doc = scan.library.find((i) => i.name === "CLAUDE.md")!;
  expect(doc.warnings).toContain("Canopy masks 1 possible secret in this file.");

  const content = read(service, doc.sourceKey, doc.digest);
  expect(content.text).toContain("Answer in short sentences.");
  expect(content.text).not.toContain(secret);
  expect(content.text).toContain("[redacted]");

  appendFileSync(join(home, ".claude", "CLAUDE.md"), "Changed\n");
  expect(() => read(service, doc.sourceKey, doc.digest)).toThrow("changed since the scan");

  // A valid key for a place that is not a library item (a session file) reads nothing.
  const session = scan.threads[0]!;
  expect(() => read(service, session.sourceKey)).toThrow("not a library item");
  const root = service.roots(["claude"]).roots[0]!;
  const credentials = signSourceKey(service.key, root, join(root.path, ".credentials.json"));
  expect(() => read(service, credentials)).toThrow("not a library item");

  // A link at a library place is not followed, in the scan or in a read.
  rmSync(join(home, ".claude", "CLAUDE.md"));
  symlinkSync(join(home, ".claude", ".credentials.json"), join(home, ".claude", "CLAUDE.md"));
  expect((await service.scan(["claude"])).library.some((i) => i.name === "CLAUDE.md")).toBe(false);
  expect(() => read(service, doc.sourceKey)).toThrow("symbolic link");
});

test("every item has its own key; a setting's key reads nothing", async () => {
  const { service } = setup();
  const { library } = await service.scan([]);
  expect(new Set(library.map((i) => i.sourceKey)).size).toBe(library.length);
  const model = library.find((i) => i.name === "model")!;
  expect(() => read(service, model.sourceKey)).toThrow();
});

test("long command paths become distinct portable skills whose scanned names match the imported artifact", async () => {
  const { service, home } = setup();
  const names = ["review-" + "a".repeat(90) + "one", "review-" + "a".repeat(90) + "two"];

  for (const name of names) writeFileSync(join(home, ".claude", "commands", `${name}.md`), "Review this change.\n");
  const scan = await service.scan(["claude"]);
  const commands = scan.library.filter((item) => item.kind === "command" && item.detail.startsWith("/review-"));
  expect(commands).toHaveLength(2);
  expect(new Set(commands.map((item) => item.name)).size).toBe(2);

  for (const command of commands) {
    expect(command.reason).toBe("");
    expect(command.name.length).toBeLessThanOrEqual(64);
    expect(command.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const content = read(service, command.sourceKey, command.digest);
    expect(Buffer.from(content.files[0]!.content).toString()).toContain(`name: ${command.name}\n`);
  }
});

test("Codex sandbox and approval policy map together to a mode that is never broader", async () => {
  const { codexSettings } = await import("./library-settings.ts");

  const mode = (sandbox: string, approval: string) =>
    codexSettings({
      ...(sandbox && { sandbox_mode: sandbox }),
      ...(approval && { approval_policy: approval }),
    }).find((f) => f.name === "permissions");

  expect(mode("workspace-write", "untrusted")?.value).toBe("");
  expect(mode("workspace-write", "on-request")?.value).toBe("accept_edits");
  expect(mode("workspace-write", "on-failure")?.value).toBe("accept_edits");
  expect(mode("workspace-write", "never")?.value).toBe("full_auto");
  expect(mode("workspace-write", "")?.value).toBe("accept_edits");
  expect(mode("read-only", "never")?.value).toBe("read_only");
  expect(mode("read-only", "untrusted")?.value).toBe("");
  expect(mode("", "untrusted")?.value).toBe("");
  // Full access is never imported; an unknown value imports nothing.
  expect(mode("danger-full-access", "untrusted")).toMatchObject({ value: "" });
  expect(mode("", "never")).toMatchObject({ value: "" });
  expect(mode("workspace-write", "sometimes")).toMatchObject({
    value: "",
    reason: "Canopy has no matching permission mode.",
  });
});

test("structured Codex policies stay unavailable, including active profile overrides", async () => {
  const { service, home } = setup();

  for (const prefix of ["", 'approval_policy = "on-request"\nprofile = "granular"\n[profiles.granular]\n']) {
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `${prefix}sandbox_mode = "workspace-write"\napproval_policy = { granular = { sandbox_approval = true } }\n`,
    );
    const item = (await service.scan(["codex"])).library.find((i) => i.name === "permissions");
    expect(item).toMatchObject({ value: "", detail: "Unsupported permission policy" });
    expect(item?.reason).toBeTruthy();
  }
});

test("skills of every CLI and of ~/.agents, commands and prompts as skills, marketplaces and plugins", async () => {
  const { service, home } = setup();
  const before = treeFingerprint(home);
  const { library } = await service.scan([]);

  const of = (kind: string, cli: string, name: string) =>
    library.find((i) => i.kind === kind && i.agentCli === cli && i.name === name);

  const claudeSkill = of("skill", "claude", "fixture-review")!;
  expect(claudeSkill).toMatchObject({ reason: "", files: 2, detail: "Review a change for the fixture tests." });
  // The same skill in two CLIs has one digest: the gateway shows it once.
  expect(of("skill", "codex", "fixture-review")?.digest).toBe(claudeSkill.digest);
  expect(of("skill", "grok", "grok-only")?.reason).toBe("");
  expect(of("skill", "codex", "shared-notes")).toMatchObject({ source: "https://github.com/fixture/skills.git" });

  expect(of("command", "claude", "git-commit")).toMatchObject({ reason: "", detail: "/git/commit" });
  expect(of("command", "claude", "git-commit")?.warnings).toContain(
    "Uses $ARGUMENTS; a skill gets them from the request.",
  );
  expect(of("command", "codex", "explain")).toMatchObject({ reason: "", detail: "/explain" });

  expect(of("marketplace", "claude", "fixture-market")).toMatchObject({ source: "fixture/market", reason: "" });
  expect(of("marketplace", "codex", "fixture-market")).toMatchObject({
    source: "https://github.com/fixture/market.git",
  });
  expect(of("marketplace", "claude", "local-market")?.reason).toContain("on this computer");
  expect(of("plugin", "claude", "review@fixture-market")).toMatchObject({ version: "1.2.0" });
  expect(of("plugin", "claude", "review@fixture-market")?.reason).toContain("Approve each one");
  expect(treeFingerprint(home)).toBe(before);

  // Reading: the skill's files with their executable bit; a command as one generated SKILL.md.
  const skill = read(service, claudeSkill.sourceKey, claudeSkill.digest);
  expect(skill.files.map((f) => [f.path, f.executable])).toEqual([
    ["SKILL.md", false],
    ["scripts/run.sh", true],
  ]);
  const command = read(service, of("command", "claude", "git-commit")!.sourceKey);
  expect(Buffer.from(command.files[0]!.content).toString()).toContain("name: git-commit");
  // A marketplace or plugin key reads nothing.
  expect(() => read(service, of("plugin", "claude", "review@fixture-market")!.sourceKey)).toThrow();
});

test("a skill reads only its own regular files: a link is not followed, secrets are masked, a bad one says why", async () => {
  const { service, home } = setup();
  const secret = `skill-secret-${"q".repeat(20)}`;
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ token: secret }));
  const dir = join(home, ".claude", "skills", "fixture-review");
  appendFileSync(join(dir, "SKILL.md"), `Token: ${secret}\n`);
  writeFileSync(join(home, "outside.txt"), "OUTSIDE_CANARY");
  symlinkSync(join(home, "outside.txt"), join(dir, "linked.txt"));
  mkdirSync(join(home, ".claude", "skills", "broken"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "broken", "SKILL.md"), "no frontmatter\n");
  const { library } = await service.scan(["claude"]);
  const skill = library.find((i) => i.kind === "skill" && i.name === "fixture-review")!;

  expect(skill.warnings).toContain("Canopy masks 1 possible secret in this skill.");
  const files = read(service, skill.sourceKey, skill.digest).files;
  const text = files.map((f) => Buffer.from(f.content).toString()).join("\n");
  expect(files.some((f) => f.path === "linked.txt")).toBe(false);
  expect(text).not.toContain("OUTSIDE_CANARY");
  expect(text).not.toContain(secret);
  expect(library.find((i) => i.kind === "skill" && i.name === "broken")?.reason).toContain("frontmatter");
});

test("a skill with a file Canopy can't mask is not imported, and no part of it leaves the worker", async () => {
  const { service, home } = setup();
  const secret = `latin-secret-${"z".repeat(20)}`;
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ token: secret }));
  const dir = join(home, ".claude", "skills", "fixture-review");
  // Latin-1 (é is 0xE9, not UTF-8): the masking reads text, so this file could carry the secret past it.
  writeFileSync(
    join(dir, "config.env"),
    Buffer.concat([Buffer.from("caf\xe9\n", "latin1"), Buffer.from(`KEY=${secret}\n`)]),
  );
  const { library } = await service.scan(["claude"]);
  const skill = library.find((i) => i.kind === "skill" && i.name === "fixture-review")!;

  expect(skill.reason).toContain("config.env is not UTF-8 text");
  expect(() => read(service, skill.sourceKey, skill.digest)).toThrow();
});

test("NUL-bearing UTF-16 and control-bearing files refuse the whole skill and reads by key", async () => {
  const { service, home } = setup();
  const dir = join(home, ".claude", "skills", "fixture-review");
  const secret = "binary-skill-CANARY-0042";
  const variants = [Buffer.from(`KEY=${secret}\n`, "utf16le"), Buffer.from(`\u0001\u0002KEY=${secret}\n`)];

  for (const raw of variants) {
    writeFileSync(join(dir, "config.env"), raw);
    const { library } = await service.scan(["claude"]);
    const item = library.find((i) => i.kind === "skill" && i.name === "fixture-review")!;
    expect(item.reason).toContain("config.env");
    expect(item.files).toBe(0);
    expect(() => read(service, item.sourceKey)).toThrow("config.env");
    expect([item.name, item.reason, item.detail, item.value, item.source].join(" ").includes(secret)).toBe(false);
  }
});

test("marketplace and server URLs with credentials are listed masked and never imported", async () => {
  const { service, home } = setup();
  writeFileSync(
    join(home, ".claude", "plugins", "known_marketplaces.json"),
    JSON.stringify({
      ...Object.fromEntries(
        URL_BOUNDARIES.map((url, index) => [`boundary-${index}`, { source: { source: "git", url } }]),
      ),
      tokened: { source: { source: "git", url: "https://git.example.test/m.git?token=CANARYtok" } },
      userinfo: { source: { source: "url", url: "https://deploy:CANARYpass@git.example.test/u.git" } },
      encoded: { source: { source: "git", url: "https://git.example.test/e.git?%74oken=CANARYencoded" } },
      double: { source: { source: "git", url: "https://git.example.test/e.git?%2574oken=CANARYdouble" } },
      deep: { source: { source: "git", url: "https://git.example.test/e.git?%252525252574oken=CANARYdeep" } },
      ambiguous: { source: { source: "git", url: "https://git.example.test/e.git?to%ZZken=CANARYambiguous" } },
      docs: { source: { source: "git", url: "https://git.example.test/docs.git?design=compact#authentication" } },
    }),
  );
  const { library } = await service.scan(["claude"]);
  const listed = library.filter((i) => i.kind === "marketplace" && i.name !== "docs");

  expect(listed).toHaveLength(6 + URL_BOUNDARIES.length);
  expect(listed.every((i) => i.reason.includes("holds a credential"))).toBe(true);
  expect(JSON.stringify(listed.map((i) => [i.source, i.detail, i.value]))).not.toContain("CANARY");

  for (const [index, url] of URL_BOUNDARIES.entries()) {
    expect(library.find((item) => item.name === `boundary-${index}`)?.source).not.toBe(url);
  }

  expect(library.find((i) => i.name === "docs")).toMatchObject({
    source: "https://git.example.test/docs.git?design=compact#authentication",
    reason: "",
  });
});

const secretOf = (
  service: WorkerImport,
  item: { sourceKey: string; digest: string },
  slot: string,
  confirmation = "c".repeat(64),
) =>
  readImportSecret(
    service,
    create(ReadImportSecretSchema, { sourceKey: item.sourceKey, slot, confirmation, digest: item.digest }),
  );

test("MCP servers: remote ones with their secret slots by name only, stdio ones with why they stay out", async () => {
  const { service } = setup();
  const scan = await service.scan([]);

  const of = (cli: string, name: string) =>
    scan.library.find((i) => i.kind === "connector" && i.agentCli === cli && i.name === name);

  const remote = of("claude", "fixture-remote")!;
  expect(remote).toMatchObject({ transport: "http", detail: "https://mcp.example.invalid/mcp", reason: "" });
  expect(remote.slots.map((s) => [s.name, s.kind, s.variable])).toEqual([
    ["Authorization", "env", "FIXTURE_TOKEN"],
    ["X-Team", "literal", ""],
  ]);
  expect(of("claude", "fixture-project (project)")).toMatchObject({ transport: "sse" });
  expect(of("claude", "fixture-local")?.reason).toContain("Runs a command on this computer");
  expect(of("codex", "fixture-codex")?.slots.map((s) => [s.name, s.kind, s.variable])).toEqual([
    ["Authorization", "env", "FIXTURE_CODEX_TOKEN"],
  ]);
  expect(of("codex", "fixture-stdio")?.reason).toContain("Runs a command");
  expect(scan.library.find((i) => i.name === "Model provider fixture-proxy")?.reason).toContain("Proxies");
  // No value leaves the worker with the scan.
  expect(toJsonString(ImportScanSchema, scan)).not.toContain("fixture-team-value-0001");
});

test("nested MCP slot names and variable metadata use the same masking entry point", async () => {
  const { service, home } = setup();
  const secret = "SLOT_CANARY_CREDENTIAL_0042";
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ token: secret }));
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        nested: {
          type: "http",
          url: "https://mcp.example.test/mcp",
          headers: {
            [secret]: "literal-fixture-value",
            Authorization: `Bearer ${"${"}${secret}}`,
          },
        },
      },
    }),
  );
  writeFileSync(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.nested]\nurl = "https://mcp.example.test/mcp?unused"\n[mcp_servers.nested.env_http_headers]\nX-Test = "${secret}"\n`,
  );
  const scan = await service.scan([]);
  const slots = scan.library.filter((i) => i.kind === "connector").flatMap((i) => i.slots);
  expect(slots.some((slot) => slot.name === "[redacted]")).toBe(true);
  expect(slots.some((slot) => slot.variable === "[redacted]")).toBe(true);
  expect(toJsonString(ImportScanSchema, scan).includes(secret)).toBe(false);
});

test("a secret is read only for a literal slot of a listed server, with a confirmation, as scanned", async () => {
  const { service, home } = setup();
  const remote = (await service.scan(["claude"])).library.find((i) => i.name === "fixture-remote")!;

  expect(secretOf(service, remote, "X-Team").value).toBe("fixture-team-value-0001");
  expect(secretOf(service, remote, "X-Team", "c".repeat(64)).confirmation).toBe("c".repeat(64));
  // Without the owner's confirmation, for a variable, for a header the server lacks: nothing.
  expect(() => secretOf(service, remote, "X-Team", "")).toThrow("owner's confirmation");
  expect(() => secretOf(service, remote, "Authorization")).toThrow("no value in the file");
  expect(() => secretOf(service, remote, "X-Other")).toThrow("no value in the file");
  // A key of another kind (an instruction file, a skill) reads no secret.
  const doc = (await service.scan(["claude"])).library.find((i) => i.name === "CLAUDE.md")!;
  expect(() => secretOf(service, doc, "X-Team")).toThrow("not an MCP server");
  // The definition changed since the scan: scan again.
  const path = join(home, ".claude.json");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("https://mcp.example.invalid/mcp", "https://other.example.invalid/mcp"),
  );
  expect(() => secretOf(service, remote, "X-Team")).toThrow("changed since the scan");
});
