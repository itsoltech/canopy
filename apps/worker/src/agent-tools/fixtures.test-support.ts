import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "@canopy/testing";
import { AgentTool } from "@canopy/contracts";
import { agentToolSpec } from "./specs.ts";

export interface FixtureState {
  version?: string;
  ready?: boolean;
  denied?: boolean;
  screenRecording?: "granted" | "not_required" | "denied" | "unknown";
  platform?: string;
  emptySurfaces?: boolean;
  invalidJson?: boolean;
  failPermissionGuide?: boolean;
  failOperation?: boolean;
  delay?: number;
  text?: string;
  screenshot?: string;
  oversize?: boolean;
  symlink?: string;
  failure?: string;
}

export interface Invocation {
  tool: string;
  args: string[];
  event: string;
  privateEnv: boolean;
  setting: string;
  displayAuthority: string;
}

export function executable(path: string, script: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);

  return path;
}

export function fixture() {
  const dir = tempDir("canopy-agent-tools-");
  const log = join(dir, "calls.jsonl");
  const states = join(dir, "states");
  mkdirSync(states);

  const calls = (): Invocation[] => {
    try {
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line: string) => JSON.parse(line));
    } catch {
      return [];
    }
  };

  const state = (tool: AgentTool, value: FixtureState) =>
    writeFileSync(join(states, `${agentToolSpec(tool).executable}.json`), JSON.stringify(value));

  const script = (tool: AgentTool): string => {
    const spec = agentToolSpec(tool);

    return `
import { appendFileSync, readFileSync, writeFileSync, truncateSync, symlinkSync } from "node:fs";
const name = ${JSON.stringify(spec.executable)};
const state = JSON.parse(readFileSync(${JSON.stringify(join(states, `${spec.executable}.json`))}, "utf8"));
const args = process.argv.slice(2);
const record = event => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: name, args, event, privateEnv: Boolean(process.env.CANOPY_WORKER_TOKEN || process.env.API_KEY), setting: process.env.AGENT_TEST_SETTING || "", displayAuthority: process.env.XAUTHORITY || "" }) + "\\n");
record("start");
if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
record("end");
if (args.includes("--version")) { console.log(name + " " + (state.version ?? ${JSON.stringify(spec.version)})); process.exit(0); }
if (args[0] === "install") { console.log("runtime installed"); process.exit(0); }
if (name === "agent-desktop" && args.join(" ") === "permissions --guide") {
  if (state.failPermissionGuide) process.exit(1);
  console.log(JSON.stringify({ ok: true, data: { guide: "started" } })); process.exit(0);
}
if (args[0] === "doctor" || args[0] === "status") {
  if (state.invalidJson) { console.log("not json"); process.exit(0); }
  const ready = state.ready !== false;
  const fail = state.failure ?? "Runtime is missing";
  const result = name === "agent-browser" ? { success: ready, checks: [{ id: ready ? "launch.elapsed" : "chrome.installed", status: ready ? "pass" : "fail", message: ready ? "Ready" : fail }] }
    : name === "agent-desktop" ? { ok: true, data: { platform: state.platform ?? "linux", supported_surfaces: state.emptySurfaces ? [] : ["window"], permissions: { accessibility: {state: state.denied ? "denied" : "granted"}, screen_recording: {state: state.screenRecording ?? "not_required"} } } }
    : { success: true, data: { status: ready ? "pass" : "fail", checks: [{id: "device", status: ready ? "pass" : "fail", summary: ready ? "Device found" : fail}] } };
  console.log(JSON.stringify(result)); process.exit(ready ? 0 : 1);
}
const shot = args.indexOf("screenshot");
if (shot >= 0) {
  const destination = args.at(-1);
  if (state.symlink) symlinkSync(state.symlink, destination);
  else if (state.oversize) { writeFileSync(destination, ""); truncateSync(destination, 4 * 1024 * 1024 + 1); }
  else writeFileSync(destination, Buffer.from(state.screenshot ?? "invalid", "base64"));
}
console.log(JSON.stringify(state.failOperation ? { success: false, error: "ref failed" } : { success: true, data: state.text ?? args }));
`;
  };

  const paths = new Map<AgentTool, string>();

  for (const tool of [AgentTool.BROWSER, AgentTool.DESKTOP, AgentTool.DEVICE]) {
    state(tool, {});
    paths.set(tool, executable(join(dir, "bin", agentToolSpec(tool).executable), script(tool)));
  }

  const path = (tool: AgentTool): string => {
    const value = paths.get(tool);

    if (!value) throw new Error("Missing fixture executable");

    return value;
  };

  const which = (name: string) =>
    [...paths.entries()].find(([tool]) => agentToolSpec(tool).executable === name)?.[1] ?? null;

  return {
    dir,
    log,
    state,
    script,
    path,
    which,
    calls,
    env: {
      PATH: process.env["PATH"],
      HOME: dir,
      AGENT_TEST_SETTING: "preserved",
      XAUTHORITY: join(dir, "display-cookie"),
      CANOPY_WORKER_TOKEN: "worker-private-value",
      API_KEY: "provider-private-value",
    },
  };
}
