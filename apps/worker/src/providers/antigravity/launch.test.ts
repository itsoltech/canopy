import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PermissionMode } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { antigravityLaunch, type AntigravityInstance } from "./launch.ts";
import { antigravitySessionRoot } from "./home.ts";
import { listAntigravityModels } from "./catalog.ts";

const rootFor = tempDirs();

function instance(): AntigravityInstance {
  const root = rootFor("canopy-antigravity-home-");
  const deviceHome = join(root, ".gemini", "antigravity-cli");
  mkdirSync(deviceHome, { recursive: true });

  return {
    dataDir: join(root, "worker"),
    deviceHome,
    linkDeviceLogin: true,
    executable: join(import.meta.dir, "fixtures", "agent.ts"),
    profile: { kind: "native", id: "native", providers: ["antigravity"], runtime: {}, env: {} },
    baseEnv: {
      HOME: root,
      PATH: process.env["PATH"],
      ANTIGRAVITY_GEMINI_DIR: deviceHome,
      AGY_CLI_DISABLE_SAFETY_FILTERING: "true",
    },
  };
}

test("only the device login and reconciled skills enter a process, and each thread retains its own conversation", () => {
  const options = instance();
  const device = options.deviceHome!;
  writeFileSync(join(device, "antigravity-oauth-token"), "synthetic login");
  writeFileSync(join(device, "settings.json"), '{"toolPermission":"always-proceed"}');
  writeFileSync(join(device, "hooks.json"), "{}");
  const cwd = rootFor("canopy-antigravity-cwd-");

  const open = (threadId: string) => {
    const launch = antigravityLaunch({ ...options, cwd, threadId, permissionMode: PermissionMode.ASK });
    const root = launch.options.args[launch.options.args.indexOf("--gemini-dir") + 1]!;

    return { ...launch, root, app: join(root, "antigravity-cli") };
  };

  const first = open("first");
  const sibling = open("sibling");

  try {
    expect(first.options.env?.["HOME"]).toBe(options.baseEnv?.["HOME"]);
    expect(first.options.env?.["ANTIGRAVITY_GEMINI_DIR"]).toBeUndefined();
    expect(first.options.env?.["AGY_CLI_DISABLE_SAFETY_FILTERING"]).toBeUndefined();
    expect(realpathSync(join(first.app, "antigravity-oauth-token"))).toBe(
      realpathSync(join(device, "antigravity-oauth-token")),
    );
    expect(realpathSync(join(first.app, "skills"))).toBe(
      realpathSync(join(options.dataDir, "antigravity-home", "skills")),
    );
    expect(existsSync(join(first.app, "hooks.json"))).toBe(false);
    const settings = join(first.app, "settings.json");
    expect(readFileSync(settings, "utf8")).toContain('"toolPermission":"request-review"');

    if (process.platform !== "win32") expect(lstatSync(settings).mode & 0o777).toBe(0o600);
    writeFileSync(join(first.app, "conversations", "test.db"), "test session");
    writeFileSync(join(first.app, "brain", "artifact"), "test artifact");
    expect(existsSync(join(sibling.app, "conversations", "test.db"))).toBe(false);
    expect(existsSync(join(sibling.app, "brain", "artifact"))).toBe(false);
  } finally {
    first.cleanup();
    sibling.cleanup();
  }

  const resumed = open("first");

  try {
    expect(first.root).not.toBe(resumed.root);
    expect(existsSync(first.root)).toBe(false);
    expect(readFileSync(join(resumed.app, "conversations", "test.db"), "utf8")).toBe("test session");
    expect(readFileSync(join(resumed.app, "brain", "artifact"), "utf8")).toBe("test artifact");
    expect(readFileSync(join(device, "settings.json"), "utf8")).toBe('{"toolPermission":"always-proceed"}');
  } finally {
    resumed.cleanup();
  }
});

test("the skill grant only permits native reads of matching files inside this instance's mounted bundles", async () => {
  const options = instance();
  const cwd = rootFor("canopy-agy-skill-workspace-");
  const privateHome = rootFor("canopy-agy-custom-skills-");

  const launch = antigravityLaunch({
    ...options,
    profile: { ...options.profile, runtime: { shadowHomePath: privateHome } },
    cwd,
    threadId: "with-skills",
    permissionMode: PermissionMode.READ_ONLY,
  });

  const gemini = launch.options.args[launch.options.args.indexOf("--gemini-dir") + 1]!;
  const mount = join(gemini, "antigravity-cli", "skills");
  const bundle = join(privateHome, "skills", "example");

  const read = (input: string, listed: string, name = "read_file") => ({
    toolCallId: "skill",
    kind: "read" as const,
    name,
    rawInput: { Path: input },
    locations: [{ path: listed }],
  });

  try {
    mkdirSync(bundle);
    const target = join(bundle, "SKILL.md");
    const alias = join(mount, "example", "SKILL.md");
    writeFileSync(target, "Fixture");
    const reference = join(bundle, "notes.md");
    writeFileSync(reference, "Reference");
    const external = join(cwd, "SKILL.md");
    writeFileSync(external, "Outside");
    symlinkSync(cwd, join(bundle, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(launch.allowSkillRead(read(alias, target))).toBe(true);
    expect(launch.allowSkillRead(read(reference, reference))).toBe(true);
    expect(launch.allowSkillRead(read(external, external))).toBe(false);
    expect(launch.allowSkillRead(read(alias, external))).toBe(false);
    const mixed = { ...read(alias, target), args: { Path: external } };
    expect(launch.allowSkillRead(mixed)).toBe(false);
    expect(launch.allowSkillRead(read(alias, target, "write_file"))).toBe(false);
    expect(launch.allowSkillRead({ ...read(alias, target), kind: "edit" })).toBe(false);
    expect(launch.allowSkillRead(read(join(mount, "example", "linked", "SKILL.md"), external))).toBe(false);
  } finally {
    await launch.cleanup();
  }
});

test("a catalog reads each model's ACP configuration without creating durable thread data", async () => {
  const options = instance();
  const { models } = await listAntigravityModels(options);
  expect(models).toMatchObject([
    { id: "gemini-3.1-pro", isDefault: true, efforts: ["low", "medium"], defaultEffort: "low" },
    { id: "gemini-4-carbon", isDefault: false, efforts: ["low", "high"] },
  ]);
  expect(existsSync(antigravitySessionRoot(options.dataDir, "native"))).toBe(false);
  expect(readdirSync(join(options.dataDir, "antigravity", "native"))).toEqual([]);
});
