import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentTool,
  InstallAgentToolSchema,
  AgentToolInstallStatusSchema,
  type AgentToolInstallStatus,
} from "@canopy/contracts";
import { AgentTools } from "./index.ts";
import { installAgentTool, type AgentToolInstallInput } from "./install.ts";
import { managedPrefix, resolveLauncher } from "./paths.ts";
import { agentToolSpec } from "./specs.ts";
import { executable, fixture } from "./fixtures.test-support.ts";

const command = (tool = AgentTool.BROWSER, id = "install-test") =>
  create(InstallAgentToolSchema, { tool, installId: id, installRuntime: true });

function installer(f: ReturnType<typeof fixture>, diagnostic = "", brokenVersion = false) {
  const templates = new Map<string, string>();

  for (const tool of [AgentTool.BROWSER, AgentTool.DESKTOP, AgentTool.DEVICE]) {
    const name = agentToolSpec(tool).executable;
    const path = join(f.dir, `${name}.template`);
    executable(path, brokenVersion ? 'console.log("0.0.1");' : f.script(tool));
    templates.set(name, path);
  }

  const log = join(f.dir, "npm.jsonl");

  const path = executable(
    join(f.dir, "npm"),
    `
import { appendFileSync, copyFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const write = event => appendFileSync(${JSON.stringify(log)}, JSON.stringify({event, args, secret: Boolean(process.env.API_KEY || process.env.CANOPY_WORKER_TOKEN)}) + "\\n");
write("start");
await new Promise(resolve => setTimeout(resolve, 30));
const prefix = args[args.indexOf("--prefix") + 1];
const name = args.at(-1).split("@")[0];
const templates = new Map(${JSON.stringify([...templates])});
mkdirSync(join(prefix, "bin"), { recursive: true });
const path = join(prefix, "bin", name);
copyFileSync(templates.get(name), path); chmodSync(path, 0o700);
console.log(${JSON.stringify(diagnostic)});
write("end");
`,
  );

  return {
    path,
    calls: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

test("installs use a managed prefix, exact package version, stripped env and verified browser runtime", async () => {
  const f = fixture();
  const npm = installer(f, "provider-private-value worker-private-value");
  const lines: string[] = [];
  const spec = agentToolSpec(AgentTool.BROWSER);
  await installAgentTool({
    command: command(),
    spec,
    npm: npm.path,
    dataDir: f.dir,
    env: f.env,
    platform: "linux",
    emit: async (line) => {
      lines.push(line);
    },
  });
  const calls = npm.calls();

  expect(calls[0].args).toEqual([
    "install",
    "--global",
    "--prefix",
    managedPrefix(f.dir, spec),
    "--no-fund",
    "--no-audit",
    "--include=optional",
    "--allow-scripts=agent-browser",
    "agent-browser@0.43.0",
  ]);
  expect(calls[0].secret).toBe(false);
  expect(lines.join("\n")).not.toContain("provider-private-value");
  expect(lines.join("\n")).not.toContain("worker-private-value");
  expect(f.calls().map((call) => call.args[0])).toEqual([
    "--version",
    "--version",
    "install",
    "install",
    "doctor",
    "doctor",
  ]);
});

test("all AgentTools instances serialize npm recipes sharing their installation resources", async () => {
  const f = fixture();
  const npm = installer(f);
  const emit = async () => {};

  await Promise.all(
    [AgentTool.BROWSER, AgentTool.DESKTOP].map((tool) =>
      installAgentTool({
        command: command(tool),
        spec: agentToolSpec(tool),
        npm: npm.path,
        dataDir: f.dir,
        env: f.env,
        platform: "linux",
        emit,
      }),
    ),
  );

  expect(npm.calls().map((call) => call.event)).toEqual(["start", "end", "start", "end"]);
});

test("a successful npm exit is rejected when the package version or actual runtime is wrong", async () => {
  const f = fixture();
  const wrong = installer(f, "", true);

  const input: AgentToolInstallInput = {
    command: command(),
    spec: agentToolSpec(AgentTool.BROWSER),
    npm: wrong.path,
    dataDir: f.dir,
    env: f.env,
    platform: "linux",
    emit: async () => {},
  };

  await expect(installAgentTool(input)).rejects.toThrow("expected version 0.43.0");
  const missing = installer(f);
  f.state(AgentTool.BROWSER, { ready: false, failure: "Chrome cannot launch" });
  await expect(installAgentTool({ ...input, npm: missing.path })).rejects.toThrow("Chrome cannot launch");
});

test("install status survives throwing and rejected reporting sinks, with redacted failure details", async () => {
  const f = fixture();
  const npm = installer(f);
  f.state(AgentTool.BROWSER, { ready: false, failure: "Missing worker-private-value provider-private-value" });
  let resolveFinished: (status: AgentToolInstallStatus) => void = () => {};

  const finished = new Promise<AgentToolInstallStatus>((resolve) => {
    resolveFinished = resolve;
  });

  const manager = new AgentTools({
    dataDir: f.dir,
    probe: { which: (name) => (name === "npm" ? npm.path : null), platform: "linux" },
    env: f.env,
    send: async (report) => {
      const install = report.tools?.find((tool) => tool.tool === AgentTool.BROWSER)?.install;

      if (install && install.state !== "running") resolveFinished(create(AgentToolInstallStatusSchema, install));
      throw new Error("disconnected report sink");
    },
    progress: () => {
      throw new Error("disconnected progress sink");
    },
  });

  await manager.install(command());
  const status = await finished;

  expect(status.state).toBe("failed");
  expect(status.error).not.toContain("worker-private-value");
  expect(status.error).not.toContain("provider-private-value");
  expect(manager.last?.tools?.find((tool) => tool.tool === AgentTool.BROWSER)?.ready).toBe(false);
});

test("npm command shims are resolved to typed package entries without a command shell", () => {
  const f = fixture();
  const shim = join(f.dir, "win", "npm.cmd");
  const entry = executable(join(f.dir, "win", "node_modules", "npm", "bin", "npm-cli.js"), "");
  writeFileSync(
    join(f.dir, "win", "node_modules", "npm", "package.json"),
    JSON.stringify({ bin: { npm: "bin/npm-cli.js" } }),
  );

  expect(resolveLauncher(shim, "npm")).toBe(entry);
  writeFileSync(
    join(f.dir, "win", "node_modules", "npm", "package.json"),
    JSON.stringify({ bin: { npm: "../../../payload.js" } }),
  );
  expect(resolveLauncher(shim, "npm")).toBe("");
});
