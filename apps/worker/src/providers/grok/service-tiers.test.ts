import { expect, test } from "bun:test";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  ThreadEventSchema,
  ThreadSpecSchema,
  UserInputSchema,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { GrokThreads } from "./threads.ts";

const temporary = tempDirs();

test("Grok ACP catalogs no independent speed and rejects an unsupported turn before submission", async () => {
  const root = temporary("canopy-grok-speed-");

  const threads = new GrokThreads({
    dataDir: root,
    executable: join(import.meta.dir, "fixtures/agent.ts"),
    linkDeviceLogin: false,
    profile: () => ({ kind: "native", id: "native", providers: ["grok"], runtime: {}, env: {} }),
    record: async () => create(ThreadEventSchema),
    interact: async () => create(InteractionResponseSchema),
    callTool: async () => create(AgentToolResultSchema),
  });

  try {
    const catalog = await threads.listModels("native");
    expect(catalog.models.every((model) => !model.serviceTiers?.length)).toBe(true);
    const spec = create(ThreadSpecSchema, { threadId: crypto.randomUUID(), cwd: root });
    await expect(
      threads.startTurn(spec, crypto.randomUUID(), create(UserInputSchema, { text: "Must not run" }), {
        model: "",
        effort: "",
        serviceTier: "fast",
      }),
    ).rejects.toThrow("does not support independent speed");
    spec.serviceTier = "fast";
    await expect(threads.create(spec)).rejects.toThrow("does not support independent speed");
    spec.serviceTier = "default";
    expect(await threads.create(spec)).not.toBe("");
  } finally {
    await threads.close();
  }
}, 15_000);
