import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentTool } from "@canopy/contracts";
import { AgentTools } from "./index.ts";
import { executable, fixture } from "./fixtures.test-support.ts";
import { AGENT_TOOL_SPECS } from "./specs.ts";

export interface CleanupState {
  sessions: Record<string, number[]>;
  running?: boolean;
  failClose?: boolean;
  version?: string;
  waitClose?: string;
  desktopEnded?: string[];
  history?: string[];
  snapshots?: number;
}

export function cleanupFixture() {
  const f = fixture();
  const statePath = (tool: AgentTool) => join(f.dir, `cleanup-${tool}.json`);
  const state = (tool: AgentTool, next: CleanupState) => writeFileSync(statePath(tool), JSON.stringify(next));
  const read = (tool: AgentTool): CleanupState => JSON.parse(readFileSync(statePath(tool), "utf8"));

  for (const spec of AGENT_TOOL_SPECS) {
    state(spec.tool, { sessions: {}, running: false });
    executable(
      f.path(spec.tool),
      `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
const path = ${JSON.stringify(statePath(spec.tool))};
let state = JSON.parse(readFileSync(path, "utf8"));
appendFileSync(${JSON.stringify(f.log)}, JSON.stringify({tool:${JSON.stringify(spec.executable)}, args, event:"start", privateEnv:Boolean(process.env.API_KEY || process.env.CANOPY_WORKER_TOKEN)}) + "\\n");
const ok = data => console.log(JSON.stringify({success:true,ok:true,data}));
const fail = (code,message) => {console.log(JSON.stringify({success:false,ok:false,error:{code,message}}));process.exit(1);};
if (args.includes("--version")) {console.log(state.version ?? ${JSON.stringify(spec.version)});process.exit(0);}
if (args[0] === "status") {ok({platform:"linux",supported_surfaces:["window"],permissions:{accessibility:{state:"granted"},screen_recording:{state:"not_required"}}});process.exit(0);}
if (JSON.stringify(args) === '["--json","daemon","status"]') {ok({state:state.running?"running":"stopped"});process.exit(0);}
if (args.at(-1) === "list") {
  if (!args.includes("session")) fail("INVALID_ARGS","session list required");
  const sessions = Object.keys(state.sessions).map(name => {
    if (${spec.tool === AgentTool.BROWSER}) return name;
    if (${spec.tool === AgentTool.DEVICE}) return {name};
    return {session_id:name, ended_at:state.desktopEnded?.includes(name)?1:null};
  });
  ok({sessions});process.exit(0);
}
const session = args.includes("--session") ? args[args.indexOf("--session")+1] : args.at(-1);
if (${spec.tool === AgentTool.DESKTOP} && args.includes("snapshot")) {
  if (state.desktopEnded?.includes(session)) fail("INVALID_ARGS","session_ended");
  state.snapshots=(state.snapshots??0)+1;writeFileSync(path,JSON.stringify(state));ok({snapshot:state.snapshots});process.exit(0);
}
// Reproduce upstream's permanent end semantics, so a regression to session end breaks reopen tests.
if (${spec.tool === AgentTool.DESKTOP} && args[0] === "session" && args[1] === "end") {
  state.desktopEnded=[...(state.desktopEnded??[]),session];writeFileSync(path,JSON.stringify(state));ok({ended_at:1});process.exit(0);
}
const valid = ${spec.tool === AgentTool.DESKTOP ? 'JSON.stringify(args) === JSON.stringify(["--session",session,"cursor-overlay","disable"])' : 'JSON.stringify(args) === JSON.stringify(["--json","--session",session,"close"])'};
if (!valid) fail("INVALID_ARGS","Unexpected cleanup command");
if (state.failClose) fail("COMMAND_FAILED","cleanup failed");
if (state.waitClose) while (!existsSync(state.waitClose)) await new Promise(resolve => setTimeout(resolve, 5));
state = JSON.parse(readFileSync(path,"utf8"));
const pids = state.sessions[session];
if (!pids) fail("SESSION_NOT_FOUND","No active session");
for (const pid of pids) process.kill(pid,"SIGTERM");
if (${spec.tool === AgentTool.DESKTOP}) state.sessions[session]=[];
else delete state.sessions[session];
writeFileSync(path,JSON.stringify(state));
ok({closed:true,session});
`,
    );
  }

  const manager = () =>
    new AgentTools({
      dataDir: f.dir,
      env: f.env,
      probe: { which: f.which, platform: "linux" },
      send: () => {},
      progress: () => {},
    });

  return { ...f, state, read, manager };
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;

  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Cleanup fixture timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
