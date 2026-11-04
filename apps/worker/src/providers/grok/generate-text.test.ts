import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempDir } from "@canopy/testing";
import { generateGrokText } from "./generate-text.ts";
import type { ResolvedProfile } from "../profiles.ts";
import { Schema } from "effect";

interface Trace {
  event: string;
  pid: number;
  home: string;
  cwd: string;
  authPath: string;
  childPid: number;
  capabilities: { fs: { readTextFile: boolean; writeTextFile: boolean }; terminal: boolean };
  params: {
    cwd: string;
    mcpServers: unknown[];
    _meta: { autoMode: boolean; yoloMode: boolean; agentProfile: { tools: unknown[]; injectDefaultTools: boolean } };
  };
  skills: boolean;
  durableSessions: boolean;
  config: string;
  args: string[];
  id: string;
  result: { outcome: { outcome: string; optionId?: string } };
}

function fixture() {
  const dir = tempDir("canopy-grok-text-");
  const traceFile = join(dir, "trace.jsonl");
  const fake = resolve(import.meta.dir, "fixtures/text-agent.ts");
  writeFileSync(join(dir, "auth.json"), "{}");

  const profile: ResolvedProfile = {
    kind: "native",
    id: "native",
    providers: ["grok"],
    env: { GROK_TEXT_TRACE: traceFile },
    runtime: { homePath: dir, executablePath: fake, launchArgs: ["--fixture-arg"] },
  };

  return {
    dir,
    profile,
    options: { dataDir: dir, profile, timeoutMs: 2000 },
    trace: () =>
      readFileSync(traceFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Trace),
  };
}

function cleaned(dir: string, trace: Trace[]) {
  expect(readdirSync(join(dir, "text-generation"))).toEqual([]);

  for (const entry of trace.filter((t) => t.event === "spawn")) {
    expect(existsSync(entry.home)).toBe(false);
    expect(() => process.kill(entry.pid, 0)).toThrow();
  }
}

test("Grok native requests use separate disposable ACP homes, no workspace, skills, MCP or client tools", async () => {
  const f = fixture();
  const input = { model: "grok-4.7-fast", effort: "low", prompt: "Describe the task" };
  expect(
    await Promise.all([
      generateGrokText(input, f.options, new AbortController().signal),
      generateGrokText(input, f.options, new AbortController().signal),
    ]),
  ).toEqual(["Grok title", "Grok title"]);
  const trace = f.trace();
  const sessions = trace.filter((t) => t.event === "session");
  expect(new Set(sessions.map((s) => s.home)).size).toBe(2);

  for (const session of sessions) {
    expect(session.params).toMatchObject({ mcpServers: [], _meta: { autoMode: false, yoloMode: false } });
    expect(session.params.cwd.startsWith(join(f.dir, "text-generation"))).toBe(true);
    expect(session.params.cwd).not.toBe(f.dir);
    expect(session.skills).toBe(false);
    expect(session.durableSessions).toBe(false);
    expect(session.params._meta.agentProfile).toMatchObject({ tools: [], injectDefaultTools: false });
    expect(session.args).toEqual(expect.arrayContaining(["--model", input.model, "--reasoning-effort", "low"]));
    expect(session.args).not.toContain("--fixture-arg");
    expect(session.config).toContain('action = "deny"');
  }

  for (const init of trace.filter((t) => t.event === "initialize"))
    expect(init.capabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });

  for (const spawn of trace.filter((t) => t.event === "spawn")) expect(spawn.authPath).toBe(join(f.dir, "auth.json"));
  expect(readFileSync(join(f.dir, "auth.json"), "utf8")).toBe("{}");
  cleaned(f.dir, trace);
});

test("Grok proxy generation configures only the CLI endpoint and keeps its key out of config and argv", async () => {
  const f = fixture();

  const profile: ResolvedProfile = {
    ...f.profile,
    kind: "cliproxyapi",
    baseUrl: new URL("https://proxy.invalid/v1"),
    apiKey: "fixture-secret",
  };

  expect(
    await generateGrokText(
      { model: "grok-3-mini", effort: "", prompt: "Describe the task" },
      { ...f.options, profile },
      new AbortController().signal,
    ),
  ).toBe("Grok title");
  const trace = f.trace();
  const session = trace.find((t) => t.event === "session")!;
  expect(session.config).toContain('base_url = "https://proxy.invalid/v1"');
  expect(session.config).toContain('env_key = "CANOPY_GROK_API_KEY"');
  expect(session.config).not.toContain(profile.apiKey);
  expect(session.args.join(" ")).not.toContain(profile.apiKey);
  expect(trace.find((t) => t.event === "spawn")?.authPath).toBe("");
  cleaned(f.dir, trace);
});

test("Grok isolates state while retaining an instance's own login in its durable home", async () => {
  const f = fixture();
  const source = join(f.dir, "homes", "grok-native");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "auth.json"), "{}");
  const profile = { ...f.profile, runtime: { ...f.profile.runtime, ownLogin: true } };
  await generateGrokText(
    { model: "grok-4.6", effort: "", prompt: "Describe the task" },
    { ...f.options, profile },
    new AbortController().signal,
  );
  expect(f.trace().find((t) => t.event === "spawn")?.authPath).toBe(join(source, "auth.json"));
  expect(readFileSync(join(source, "auth.json"), "utf8")).toBe("{}");
  cleaned(f.dir, f.trace());
});

test("Grok honors disabled device login for a native instance with an environment key", async () => {
  const f = fixture();
  const profile = { ...f.profile, env: { ...f.profile.env, XAI_API_KEY: "fixture-key" } };
  await generateGrokText(
    { model: "grok-4.6", effort: "", prompt: "Describe the task" },
    { ...f.options, profile, linkDeviceLogin: false },
    new AbortController().signal,
  );
  expect(f.trace().find((t) => t.event === "spawn")?.authPath).toBe("");
  cleaned(f.dir, f.trace());
});

test("Grok text generation denies every permission, including callbacks without a reject option", async () => {
  const f = fixture();
  expect(
    await generateGrokText(
      { model: "grok-4.6", effort: "", prompt: "PERMISSION" },
      f.options,
      new AbortController().signal,
    ),
  ).toBe("Denied");
  const permissions = f.trace().filter((t) => t.event === "permission");
  expect(permissions.find((t) => t.id === "reject")?.result).toEqual({
    outcome: { outcome: "selected", optionId: "deny" },
  });
  expect(permissions.find((t) => t.id === "cancel")?.result).toEqual({ outcome: { outcome: "cancelled" } });
  cleaned(f.dir, f.trace());
});

for (const [prompt, error] of [
  ["OVERFLOW", "output limit"],
  ["OVERFLOW_THOUGHT", "output limit"],
  ["TOOL", "no tools"],
  ["REFUSE", "Incomplete"],
  ["CRASH", "Grok"],
])
  test(`Grok text generation fails safely on ${prompt} and reaps the process`, async () => {
    const f = fixture();
    await expect(
      generateGrokText({ model: "grok-4.6", effort: "", prompt: prompt! }, f.options, new AbortController().signal),
    ).rejects.toThrow(error);
    cleaned(f.dir, f.trace());
  });

for (const phase of ["initialize", "prompt"])
  test(`Grok deadline bounds ${phase} and removes its scratch home`, async () => {
    const f = fixture();
    const env = { ...f.profile.env, GROK_TEXT_HANG_INIT: phase === "initialize" ? "1" : "" };
    const profile = { ...f.profile, env };
    await expect(
      generateGrokText(
        { model: "grok-4.6", effort: "", prompt: "HANG" },
        { ...f.options, profile, timeoutMs: 300 },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    cleaned(f.dir, f.trace());
  });

test("Grok abort reaps an uncooperative CLI and its child before returning", async () => {
  const f = fixture();
  const abort = new AbortController();

  const generation = generateGrokText(
    { model: "grok-4.6", effort: "", prompt: "STUBBORN" },
    { ...f.options, timeoutMs: 10_000 },
    abort.signal,
  );

  const ended = generation.catch(() => undefined);
  const timer = setTimeout(() => abort.abort(), 500);

  try {
    await expect(generation).rejects.toThrow();
  } finally {
    clearTimeout(timer);
    abort.abort();
    await ended;
  }

  const trace = f.trace();
  expect(trace.some((t) => t.event === "child")).toBe(true);
  cleaned(f.dir, trace);

  for (const child of trace.filter((t) => t.event === "child")) expect(() => process.kill(child.childPid, 0)).toThrow();
});

test.skipIf(!Bun.which("grok"))(
  "Grok CLI sends no tool schemas to the model",
  async () => {
    const dir = tempDir("canopy-grok-text-tools-");
    const request = Promise.withResolvers<{ tools?: readonly { function: { name: string } }[] }>();
    const abort = new AbortController();

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (incoming) => {
        if (incoming.method === "POST" && new URL(incoming.url).pathname.endsWith("/chat/completions"))
          request.resolve(
            Schema.decodeUnknownSync(
              Schema.Struct({
                tools: Schema.optionalKey(
                  Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
                ),
              }),
            )(await incoming.json()),
          );

        return Response.json({ error: { message: "fixture refuses inference" } }, { status: 400 });
      },
    });

    const profile: ResolvedProfile = {
      kind: "cliproxyapi",
      id: "fixture",
      providers: ["grok"],
      env: {},
      runtime: {},
      baseUrl: server.url,
      apiKey: "fixture-key",
    };

    const generation = generateGrokText(
      { model: "grok-3-mini", effort: "", prompt: "Run ls using your shell tool now." },
      { profile, dataDir: dir, timeoutMs: 10_000 },
      abort.signal,
    );

    const ended = generation.catch((error: Error) => request.reject(error));
    const timer = setTimeout(() => request.reject(new Error("Grok did not send an inference request")), 10_000);

    try {
      const body = await request.promise;
      expect(body.tools?.map((t) => t.function.name) ?? []).toEqual([]);
    } finally {
      clearTimeout(timer);
      abort.abort();
      await ended;
      await server.stop(true);
    }

    expect(readdirSync(join(dir, "text-generation"))).toEqual([]);
  },
  15_000,
);
