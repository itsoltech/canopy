import { expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  InteractionResponseSchema,
  PermissionMode,
  ThreadSpecSchema,
  ThreadEventSchema,
  TurnOutcome,
  UserInputSchema,
} from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { tempDirs } from "@canopy/testing";
import { Schema } from "effect";
import type { AntigravityInstance } from "./launch.ts";
import { AntigravityThreads } from "./threads.ts";

const temp = tempDirs();
const cli = process.env["CANOPY_ANTIGRAVITY_EXECUTABLE"] || Bun.which("agy");
const live = test.skipIf(process.env["CANOPY_LIVE"] !== "1" || !cli);

function skill(dir: string, name: string, contents = "Fixture skill.") {
  const folder = join(dir, "skills", name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Marker_${name}\n---\n${contents}\n`);
}

const ModelRequest = Schema.Struct({
  tools: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  systemInstruction: Schema.optionalKey(Schema.Struct({ parts: Schema.Array(Schema.Struct({ text: Schema.String })) })),
  contents: Schema.Array(
    Schema.Struct({
      parts: Schema.Array(
        Schema.Struct({
          functionResponse: Schema.optionalKey(
            Schema.Struct({
              name: Schema.String,
              response: Schema.Struct({
                error: Schema.optionalKey(Schema.String),
              }),
            }),
          ),
        }),
      ),
    }),
  ),
});

function fixtureModel(
  onPrompt: (request: typeof ModelRequest.Type, body: string) => { name: string; args: JsonObject } | undefined,
) {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ModelRequest));

  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const input = decode(body);
      const functionCall = input.tools?.length ? onPrompt(input, body) : undefined;
      const part = functionCall ? { functionCall } : { text: "Done" };

      const reply = {
        candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
      };

      return new Response(`data: ${JSON.stringify(reply)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
}

function instance(root: string, model: ReturnType<typeof fixtureModel>): AntigravityInstance {
  const device = join(root, "device");

  return {
    dataDir: join(root, "worker"),
    deviceHome: join(device, ".gemini", "antigravity-cli"),
    executable: cli!,
    linkDeviceLogin: false,
    baseEnv: {
      HOME: device,
      USERPROFILE: device,
      PATH: process.env["PATH"],
      XDG_CONFIG_HOME: join(device, ".config"),
    },
    profile: {
      kind: "native",
      id: "native",
      providers: ["antigravity"],
      runtime: {},
      env: { GEMINI_API_KEY: "synthetic-key", GOOGLE_GEMINI_BASE_URL: model.url.origin },
    },
  };
}

async function turn(
  options: AntigravityInstance,
  cwd: string,
  scratch: boolean,
  permissionMode: PermissionMode,
  threadId: string,
  sessionId?: string,
) {
  let completed = false;

  const threads = new AntigravityThreads({
    ...options,
    profile: () => options.profile,
    callTool: async () => {
      throw new Error("Unexpected platform tool call");
    },
    record: async (id, { $typeName: _type, ...init }) => {
      const event = create(ThreadEventSchema, { ...init, threadId: id });

      if (event.body.case === "turnFinished") completed = event.body.value.outcome === TurnOutcome.COMPLETED;

      return event;
    },
    interact: async () => create(InteractionResponseSchema, { allow: false }),
  });

  const spec = create(ThreadSpecSchema, { threadId, cwd, scratch, permissionMode, providerThreadId: sessionId ?? "" });

  try {
    spec.providerThreadId = await threads.create(spec);

    if (sessionId) expect(spec.providerThreadId).toBe(sessionId);
    await threads.startTurn(spec, crypto.randomUUID(), create(UserInputSchema, { text: "Run the fixture." }));
    expect(completed).toBe(true);

    return spec.providerThreadId;
  } finally {
    await threads.close();
  }
}

live(
  "real agy receives the assigned library skill and workspace rules while device context stays private",
  async () => {
    const root = temp("canopy-agy-instructions-");
    const device = join(root, "device");
    const project = join(device, "project");
    const cwd = join(project, "src");
    const scratch = join(device, "scratch");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(scratch);
    mkdirSync(join(project, ".git"));
    const prompts: string[] = [];
    const marker = "Updated managed skill body from the library.";
    const assigned = join(root, "worker", "antigravity-home", "skills", "managed-skill", "SKILL.md");
    let requestSkill = false;
    let resolvedSkill: string | undefined;
    let loaded = false;

    const model = fixtureModel((request, body) => {
      prompts.push(body);

      if (requestSkill) {
        requestSkill = false;
        const instructions = request.systemInstruction?.parts.map(({ text }) => text).join("\n");
        const path = instructions?.match(/^- managed-skill \((.+)\): Marker_managed-skill/m)?.[1];
        resolvedSkill = path && existsSync(path) ? realpathSync(path) : undefined;

        if (path && resolvedSkill === realpathSync(assigned)) return { name: "read_file", args: { Path: path } };
      } else if (
        request.contents.at(-1)?.parts.some(({ functionResponse }) => functionResponse?.name === "read_file")
      ) {
        loaded = body.includes(marker);
      }

      return undefined;
    });

    const options = instance(root, model);

    try {
      skill(join(options.dataDir, "antigravity-home"), "managed-skill");
      skill(join(device, ".gemini", "antigravity-cli"), "device-cli");
      skill(join(device, ".gemini", "config"), "device-shared");
      skill(join(device, ".gemini"), "device-legacy");
      skill(join(device, ".agents"), "device-agents");
      writeFileSync(join(device, ".gemini", "GEMINI.md"), "DEVICE_RULE_FIXTURE");
      writeFileSync(join(project, "AGENTS.md"), "PROJECT_RULE_FIXTURE");

      for (const path of [cwd, scratch]) {
        prompts.length = 0;
        const threadId = crypto.randomUUID();
        const session = await turn(options, path, path === scratch, PermissionMode.ASK, threadId);
        const prompt = prompts.join("\n");
        expect(prompt.includes("Marker_managed-skill")).toBe(true);
        expect(prompt.includes("PROJECT_RULE_FIXTURE")).toBe(path === cwd);
        expect(/DEVICE_RULE_FIXTURE|Marker_device-(cli|shared|agents|legacy)/.test(prompt)).toBe(false);

        if (path === cwd) {
          skill(join(options.dataDir, "antigravity-home"), "managed-skill", marker);
          requestSkill = true;
          await turn(options, cwd, false, PermissionMode.READ_ONLY, threadId, session);
          expect(resolvedSkill).toBe(realpathSync(assigned));
          expect(loaded).toBe(true);
        }
      }

      await expect(turn(options, cwd, true, PermissionMode.ASK, crypto.randomUUID())).rejects.toThrow(
        "outside the enclosing Git repository",
      );
    } finally {
      await model.stop(true);
    }
  },
  45_000,
);

live(
  "a restored agy session checks the current task-control hook before running its implicit manage_task tool",
  async () => {
    const root = temp("canopy-agy-task-hook-");
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    let call = false;
    let taskError: string | undefined;

    const model = fixtureModel((request) => {
      if (call) {
        call = false;
        taskError = undefined;

        return { name: "manage_task", args: { Action: "kill", TaskId: "missing-fixture-task" } };
      }

      taskError = request.contents
        .at(-1)
        ?.parts.find(({ functionResponse }) => functionResponse?.name === "manage_task")?.functionResponse
        ?.response.error;

      return undefined;
    });

    const options = instance(root, model);
    const threadId = crypto.randomUUID();

    try {
      call = true;
      const sessionId = await turn(options, cwd, false, PermissionMode.FULL_ACCESS, threadId);
      expect(taskError).toContain("invalid task ID");

      for (const mode of [PermissionMode.ASK, PermissionMode.ACCEPT_EDITS, PermissionMode.READ_ONLY]) {
        call = true;
        await turn(options, cwd, false, mode, threadId, sessionId);
        expect(taskError).toContain("denied by pre-tool hook");
      }
    } finally {
      await model.stop(true);
    }
  },
  45_000,
);
