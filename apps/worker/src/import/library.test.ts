import { expect, test } from "bun:test";
import { appendFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ReadImportLibraryItemSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { installFixtureHome, installLibraryFixture, treeFingerprint } from "./fixtures/install.ts";
import { readImportLibraryItem } from "./library-read.ts";
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
    homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
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
