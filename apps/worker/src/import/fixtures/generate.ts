#!/usr/bin/env bun
/**
 * Regenerates the import fixtures (docs/import.md, "Fixtures"): runs the installed Claude Code, Codex and Grok
 * against the fake model endpoint in a throwaway HOME, then copies their session files here with every machine
 * path replaced by `/home/user`. No credentials, no inference, no user data.
 *
 *   bun apps/worker/src/import/fixtures/generate.ts [claude|codex|grok ...]
 *
 * The throwaway HOME must not be inside a Git repository: Claude Code would read the repository's instructions.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { startFakeModel } from "./fake-model.ts";
import { FIXTURE_HOME } from "./install.ts";

const OUT = join(import.meta.dir, "homes");

/** Asynchronous: the fake endpoint answers from this same process. */
async function run(cmd: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const child = Bun.spawn(cmd, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000 });

  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed (${code}): ${err.slice(-2000)}`);

  return out;
}

async function version(cli: string): Promise<string> {
  return (
    (await run([cli, "--version"], tmpdir(), { PATH: process.env["PATH"] ?? "" })).match(/\d+\.\d+\.\d+/)?.[0] ??
    "unknown"
  );
}

/** Replaces the throwaway HOME in contents and names (plain, Claude's dashed and URL-encoded forms). */
function sanitize(dir: string, root: string, home: string, url: string): void {
  const forms: [string, string][] = [
    [home, FIXTURE_HOME],
    [root, "/tmp/fixture"],
    [home.replace(/[^a-zA-Z0-9]/g, "-"), FIXTURE_HOME.replace(/[^a-zA-Z0-9]/g, "-")],
    [encodeURIComponent(home), encodeURIComponent(FIXTURE_HOME)],
    [url, "http://127.0.0.1:9"],
  ];

  const swap = (text: string) => forms.reduce((t, [from, to]) => t.split(from).join(to), text);

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const renamed = join(dir, swap(entry));

    if (renamed !== path) renameSync(path, renamed);

    if (statSync(renamed).isDirectory()) sanitize(renamed, root, home, url);
    else writeFileSync(renamed, swap(readFileSync(renamed, "utf8")));
  }
}

function copy(from: string, to: string, keep: (rel: string) => boolean): void {
  cpSync(from, to, { recursive: true, filter: (source) => keep(relative(from, source)) });
}

const generators = {
  async claude(home: string, url: string, env: Record<string, string>) {
    const session = crypto.randomUUID();

    const claude = {
      ...env,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "fixture-key",
      DISABLE_AUTOUPDATER: "1",
    };

    const args = ["--model", "claude-sonnet-4-5", "--permission-mode", "bypassPermissions", "--output-format", "json"];
    const project = join(home, "project");
    await run(
      ["claude", "-p", "Run the shell tool for FIXTURE_TOOL", "--session-id", session, ...args],
      project,
      claude,
    );
    await run(["claude", "-p", "Think hard about FIXTURE_THINK", "--resume", session, ...args], project, claude);
    await run(["claude", "-p", "Use a subagent for FIXTURE_AGENT", "--resume", session, ...args], project, claude);
    await run(["claude", "-p", "/compact", "--resume", session, ...args], project, claude);
    await run(
      ["claude", "-p", "Continue after compaction with FIXTURE_AFTER", "--resume", session, ...args],
      project,
      claude,
    );
    await run(["claude", "-p", "Hello from FIXTURE_OTHER", ...args], join(home, "other"), claude);

    return {
      from: join(home, ".claude"),
      keep: (rel: string) => rel === "" || rel === "projects" || rel.startsWith("projects/"),
    };
  },
  async codex(home: string, url: string, env: Record<string, string>) {
    const codexHome = join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      `model = "fixture-model"\nmodel_provider = "fixture"\n\n[model_providers.fixture]\nname = "fixture"\nbase_url = "${url}/v1"\nenv_key = "FIXTURE_KEY"\nwire_api = "responses"\n`,
    );
    const codex = { ...env, CODEX_HOME: codexHome, FIXTURE_KEY: "fixture-key" };
    const project = join(home, "project");
    const flags = ["--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
    await run(["codex", "exec", ...flags, "Run the shell tool for FIXTURE_TOOL"], project, codex);

    const rollout = readdirSync(join(codexHome, "sessions"), { recursive: true })
      .map(String)
      .find((p) => p.endsWith(".jsonl"))!;

    const id = /([0-9a-f-]{36})\.jsonl$/.exec(rollout)![1]!;
    await run(["codex", "exec", ...flags, "resume", id, "Think hard about FIXTURE_THINK"], project, codex);
    await run(["codex", "exec", ...flags, "Hello from FIXTURE_OTHER"], join(home, "other"), codex);

    return {
      from: codexHome,
      keep: (rel: string) =>
        rel === "" || rel === "sessions" || rel.startsWith("sessions/") || rel === "session_index.jsonl",
    };
  },
  async grok(home: string, url: string, env: Record<string, string>) {
    const grokHome = join(home, ".grok");
    mkdirSync(grokHome, { recursive: true });
    writeFileSync(
      join(grokHome, "config.toml"),
      `[cli]\nauto_update = false\nuse_leader = false\n\n[model."fixture-grok"]\nmodel = "fixture-grok"\nbase_url = "${url}/v1"\nenv_key = "FIXTURE_KEY"\napi_backend = "chat_completions"\n`,
    );

    const grok = {
      ...env,
      GROK_HOME: grokHome,
      FIXTURE_KEY: "fixture-key",
      XAI_API_KEY: "fixture-key",
      GROK_TELEMETRY_ENABLED: "0",
      GROK_FOLDER_TRUST: "0",
    };

    const project = join(home, "project");
    const flags = ["-m", "fixture-grok", "--always-approve", "--output-format", "json"];
    const first = await run(["grok", "-p", "Run the shell tool for FIXTURE_TOOL", ...flags], project, grok);

    const id =
      /"session_?[iI]d"\s*:\s*"([^"]+)"/.exec(first)?.[1] ??
      readdirSync(join(grokHome, "sessions"), { recursive: true })
        .map(String)
        .find((p) => p.endsWith("chat_history.jsonl"))!
        .split("/")
        .at(-2)!;

    await run(["grok", "-r", id, "-p", "Think hard about FIXTURE_THINK", ...flags], project, grok);

    return {
      from: grokHome,
      keep: (rel: string) =>
        (rel === "" || rel === "sessions" || rel.startsWith("sessions/")) &&
        !rel.endsWith(".lock") &&
        !rel.includes("sqlite"),
    };
  },
};

if (import.meta.main) {
  const fake = startFakeModel();
  const wanted = process.argv.slice(2);

  try {
    for (const [cli, generate] of Object.entries(generators)) {
      if (wanted.length > 0 && !wanted.includes(cli)) continue;
      const root = mkdtempSync(join(tmpdir(), `canopy-import-fixture-${cli}-`));

      if (Bun.spawnSync(["git", "rev-parse", "--git-dir"], { cwd: root, stderr: "ignore" }).exitCode === 0)
        throw new Error(`${root} is inside a Git repository; set TMPDIR outside it`);
      const home = join(root, "home");

      try {
        for (const dir of ["project", "other"]) mkdirSync(join(home, dir), { recursive: true });
        await run(["git", "init", "-q"], join(home, "project"), { PATH: process.env["PATH"] ?? "" });
        const env = { PATH: process.env["PATH"] ?? "", HOME: home, USER: "user", LANG: "C.UTF-8", TMPDIR: root };
        const { from, keep } = await generate(home, fake.url, env);
        const release = await version(cli);
        const target = join(OUT, cli, release, `.${cli}`);
        rmSync(join(OUT, cli, release), { recursive: true, force: true });
        copy(from, target, keep);
        sanitize(target, root, home, fake.url);
        console.info(`${cli}: ${target}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    await fake.stop();
  }

  if (!existsSync(OUT)) process.exitCode = 1;
}
