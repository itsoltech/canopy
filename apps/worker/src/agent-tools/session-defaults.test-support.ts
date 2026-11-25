import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AgentTool, AgentToolResultSchema, AgentToolSessionDefaultsSchema, ThreadSpecSchema } from "@canopy/contracts";
import { z } from "zod";
import { automationMcp } from "../providers/local-automation.ts";
import { AgentTools } from "./index.ts";
import { executable, fixture } from "./fixtures.test-support.ts";
import { agentToolSpec } from "./specs.ts";

const event = z.object({ kind: z.string(), args: z.array(z.string()).optional() });
const state = z.object({ launched: z.boolean(), width: z.number().optional(), height: z.number().optional() });

export async function defaultsFixture() {
  const f = fixture();
  const statePath = join(f.dir, "browser-state.json");
  const log = join(f.dir, "defaults.jsonl");
  writeFileSync(statePath, JSON.stringify({ launched: false }));
  writeFileSync(log, "");
  const server = join(import.meta.dir, "../agent-tools-mcp/fixtures/server.ts");
  const events = join(f.dir, "mcp-events.jsonl");
  writeFileSync(events, "");

  executable(
    f.path(AgentTool.BROWSER),
    `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const output = data => console.log(JSON.stringify({success: true, data}));
if (args.includes("--version")) { console.log("0.43.0"); process.exit(0); }
if (args.includes("doctor")) { console.log(JSON.stringify({success:true,checks:[{id:"launch.elapsed",status:"pass",message:"Ready"}]})); process.exit(0); }
if (args.includes("mcp")) {
 process.env.CANOPY_MCP_BROWSER_POLICY = "1";
 process.argv[2] = ${JSON.stringify(events)};
 await import(${JSON.stringify(server)});
} else {
 appendFileSync(${JSON.stringify(log)}, JSON.stringify({kind:"cli", args}) + "\\n");
 const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
 if (args.includes("session")) output({runtime:state.launched ? {browserLaunched:true} : null});
 else {
  await Bun.sleep(20);
  state.launched = true;
  const viewport = args.indexOf("viewport");
  if(viewport >= 0) { state.width = Number(args[viewport+1]); state.height = Number(args[viewport+2]); }
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  output({});
 }
}
`,
  );

  executable(
    f.path(AgentTool.DESKTOP),
    `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log(${JSON.stringify(agentToolSpec(AgentTool.DESKTOP).version)}); process.exit(0); }
if (args.includes("status")) {
 console.log(JSON.stringify({ ok: true, data: { platform: "linux", supported_surfaces: ["window"], permissions: {
  accessibility: { state: "granted" }, screen_recording: { state: "not_required" }
 } } }));
 process.exit(0);
}
if (!args.includes("mcp")) throw new Error("Unexpected Desktop command");
process.env.CANOPY_MCP_DESKTOP_POLICY = "1";
process.argv.splice(2, 0, ${JSON.stringify(events)});
await import(${JSON.stringify(server)});
`,
  );

  const tools = new AgentTools({
    dataDir: f.dir,
    env: f.env,
    probe: { which: f.which, platform: "linux" },
    send: () => {},
    progress: () => {},
  });

  await tools.report();
  let denied = false;

  const defaults = create(AgentToolSessionDefaultsSchema, {
    browser: { viewportWidth: 1440, viewportHeight: 900, colorScheme: "dark" },
    desktop: { app: "Editor" },
    device: { platform: "ios", allowBoot: true, acquireTimeoutSeconds: 1 },
  });

  const spec = create(ThreadSpecSchema, {
    threadId: "defaults-thread",
    localMcpTools: [AgentTool.BROWSER],
    agentToolDefaults: defaults,
  });

  const bridge = () => {
    const result = automationMcp(
      {
        localMcpServers: (...args) => tools.localMcpServers(...args),
        callTool: async () => {
          appendFileSync(log, JSON.stringify({ kind: denied ? "denied" : "authorized" }) + "\n");

          return create(AgentToolResultSchema, { isError: denied });
        },
      },
      spec,
      () => "active-turn",
    );

    if (!result) throw new Error("Missing automation bridge");

    return result;
  };

  return {
    ...f,
    tools,
    defaults,
    spec,
    bridge,
    mcpCalls: () => readFileSync(events, "utf8").match(/"event":"called"/g)?.length ?? 0,
    deny(value: boolean) {
      denied = value;
    },
    state: () => state.parse(JSON.parse(readFileSync(statePath, "utf8"))),
    resize() {
      writeFileSync(statePath, JSON.stringify({ launched: true, width: 800, height: 600 }));
    },
    events: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => event.parse(JSON.parse(line))),
  };
}
