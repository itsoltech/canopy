import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clone, create } from "@bufbuild/protobuf";
import { AgentTool, RunAgentToolSchema } from "@canopy/contracts";
import sharp from "sharp";
import { executable, fixture } from "../agent-tools/fixtures.test-support.ts";
import { agentToolSpec } from "../agent-tools/specs.ts";
import { AgentTools, type AgentToolsOptions } from "../agent-tools/index.ts";
import { PreviewRuntime } from "./runtime.ts";
import { toolEnvironment } from "../agent-tools/paths.ts";

export interface PreviewFixtureState {
  windows?: {
    id: string;
    title: string;
    app_name: string;
    is_focused: boolean;
    accessible?: boolean;
    pid?: number;
    process_instance?: string;
    bounds: { x: number; y: number; width: number; height: number };
  }[];
  devices?: {
    id: string;
    name: string;
    platform: string;
    booted?: boolean;
    kind?: "emulator" | "simulator" | "device";
    claimedBy?: { session: string; workspace: string };
  }[];
  sessions?: { name: string; id: string; platform: string }[];
  screenshotDelay?: number;
  screenshotGate?: string;
  windowImages?: Record<string, string>;
  readiness?: boolean;
}

export async function previewFixture(tool = AgentTool.DESKTOP, desktopPointer?: AgentToolsOptions["desktopPointer"]) {
  const f = fixture();
  const statePath = join(f.dir, "preview-state.json");
  const logPath = join(f.dir, "preview-log.jsonl");
  const pngPath = join(f.dir, "source.png");
  await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "blue" } })
    .png()
    .toFile(pngPath);

  let state: PreviewFixtureState = {
    windows: [
      {
        id: "window-1",
        title: "Document",
        app_name: "Editor",
        is_focused: true,
        bounds: { x: -100, y: 40, width: 1200, height: 600 },
      },
    ],
    devices: [{ id: "emulator-5554", name: "Test Phone", platform: "android" }],
    sessions: [{ name: "thread", id: "emulator-5554", platform: "android" }],
  };

  const update = (next: PreviewFixtureState) => {
    state = { ...state, ...next };
    writeFileSync(statePath, JSON.stringify(state));
  };

  update({});
  const spec = agentToolSpec(tool);
  executable(
    f.path(tool),
    `
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args=process.argv.slice(2);
const state=JSON.parse(readFileSync(${JSON.stringify(statePath)},"utf8"));
const commands=["doctor","status","list-windows","session","devices","screenshot","find","type","press","mouse-click","mouse-move","mouse-wheel","drag","swipe","click","scroll","keyboard","back","home","cursor-overlay"];
const command=args.find(value=>commands.includes(value));
const stdin=await new Response(Bun.stdin.stream()).text();
const record=event=>appendFileSync(${JSON.stringify(logPath)},JSON.stringify({args,command,event,stdin,secret:Boolean(process.env.API_KEY||process.env.CANOPY_WORKER_TOKEN)})+"\\n");
const ok=data=>{console.log(JSON.stringify({success:true,ok:true,command,data,error:null}));};
record("start");
if(args.includes("--version")){console.log(${JSON.stringify(spec.version)});process.exit(0);}
if(command==="doctor"){
 const ready=state.readiness!==false;
 console.log(JSON.stringify({success:true,data:{status:ready?"pass":"fail",checks:[{id:"device",status:ready?"pass":"fail",summary:"Choose a device"}]}}));process.exit(0);
}
if(args.includes("daemon")){ok({state:"stopped"});process.exit(0);}
if(command==="status"){ok({platform:"linux",supported_surfaces:["window"],permissions:{accessibility:{state:"granted"},screen_recording:{state:"not_required"}}});process.exit(0);}
if(command==="list-windows"){
 const app=args.find(arg=>arg.startsWith("--app="))?.slice(6);
 ok(app ? state.windows.filter(win=>win.app_name===app) : state.windows);
}
else if(command==="devices")ok({devices:state.devices});
else if(command==="session")ok({sessions:state.sessions});
else if(command==="find")ok({match:{ref_id:"@snapshot:e1"}});
else if(command==="cursor-overlay"){
 if(args.at(-1)!=="disable")process.exit(1);
 const session=args[args.indexOf("--session")+1];
 const file=join(${JSON.stringify(f.dir)}, ".agent-desktop", "sessions", session, "session.json");
 const manifest=JSON.parse(readFileSync(file,"utf8"));
 manifest.cursor_overlay.enabled=false;
 writeFileSync(file,JSON.stringify(manifest));
 ok({session_id:session,cursor_overlay:{enabled:false}});
}
else if(command==="screenshot"){
 if(state.screenshotDelay)await new Promise(resolve=>setTimeout(resolve,state.screenshotDelay));
 while(state.screenshotGate && !existsSync(state.screenshotGate))await new Promise(resolve=>setTimeout(resolve,10));
 const window=args.includes("--window-id") ? args[args.indexOf("--window-id")+1] : "";
 copyFileSync(state.windowImages?.[window] ?? ${JSON.stringify(pngPath)},args.at(-1));
 ok({width:2400,height:1200,logicalWidth:1200,logicalHeight:600,scale_factor:2});
}else ok({});
record("end");
`,
  );

  const tools = new AgentTools({
    dataDir: f.dir,
    ...(desktopPointer && { desktopPointer }),
    env: f.env,
    probe: { which: f.which, platform: "linux" },
    send: () => {},
    progress: () => {},
  });

  const scope = create(RunAgentToolSchema, { tool, operation: "screenshot", session: "thread" });

  const runtime = (signal = new AbortController().signal) =>
    new PreviewRuntime(
      {
        useDevice: (_signal, work) => work(),
        executable: f.path(tool),
        env: toolEnvironment(f.env),
        scope: clone(RunAgentToolSchema, scope),
        redact: (text: string) => text,
      },
      signal,
    );

  const calls = (): { args: string[]; command: string; event: string; stdin: string; secret: boolean }[] => {
    try {
      return readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };

  return { ...f, tools, scope, runtime, update, calls };
}

export async function eventually(predicate: () => boolean, timeout = 2500): Promise<void> {
  const end = Date.now() + timeout;

  while (!predicate()) {
    if (Date.now() > end) throw new Error("Preview fixture condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
