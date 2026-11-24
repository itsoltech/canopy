import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  ForkSpecSchema,
  InteractionResponseSchema,
  PermissionMode,
  SandboxProfileSchema,
  ThreadSpecSchema,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { sandboxBinding } from "@canopy/domain/sandbox-profiles";
import type { JsonObject } from "@canopy/domain";
import { tempDirs } from "@canopy/testing";
import { Layer, ManagedRuntime } from "effect";
import { Journal } from "../../journal/index.ts";
import { resolveProfiles } from "../profiles.ts";
import { decodeJsonObject } from "../json.ts";
import { CodexThreads } from "./threads.ts";

const temporary = tempDirs();
const input = create(UserInputSchema, { text: "Test input" });

const binding = (allowedDomains: string[] = []) =>
  sandboxBinding(
    create(SandboxProfileSchema, { id: "833b44a4-28b5-4f79-b726-566ab49f0c59", name: "Test", allowedDomains }),
  );

function fixture(scenario: JsonObject = {}, qualified = true) {
  const root = temporary("canopy-codex-policy-");
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd);

  const setScenario = (next: JsonObject) => writeFileSync(join(root, "scenario.json"), JSON.stringify(next));
  setScenario(scenario);
  const provider = resolveProfiles([{ id: "native", kind: "native", providers: ["codex"] }])[0]?.resolved;
  const events: ThreadEvent[] = [];

  const runtime = ManagedRuntime.make(
    CodexThreads.layer({
      launch: {
        command: [process.execPath, join(import.meta.dir, "fixtures/sandbox-profile.ts")],
        env: { CODEX_HOME: home, FIXTURE_ROOT: root },
      },
      ...(qualified && { sandboxProfileRuntime: { policyDirectory: home } }),
      profile: () => provider,
      clientVersion: "test",
      publish: (event) => events.push(event),
      interact: async () => create(InteractionResponseSchema),
      callTool: async () => create(AgentToolResultSchema),
    }).pipe(Layer.provideMerge(Journal.layer(join(root, "journal.db")))),
  );

  const spec = create(ThreadSpecSchema, {
    threadId: crypto.randomUUID(),
    cwd,
    permissionMode: PermissionMode.FULL_AUTO,
    sandboxProfile: binding(),
  });

  const trace = () =>
    readFileSync(join(root, "trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => decodeJsonObject(JSON.parse(line)));

  return { runtime, spec, home, events, trace, setScenario };
}

const linuxTest = test.skipIf(process.platform !== "linux");

linuxTest("Codex keeps the confirmed named profile on turns and rejects warm policy changes", async () => {
  const { runtime, spec, home, trace, setScenario } = fixture({ inactiveProjectAfterStart: true });

  try {
    const threads = await runtime.runPromise(CodexThreads);
    await runtime.runPromise(threads.create(spec));
    const started = trace().find((row) => row["method"] === "thread/start");
    expect(started).toMatchObject({
      approvalPolicy: "never",
      permissions: `canopy_sandbox_${binding().digest}`,
      definition: {
        extends: ":workspace",
        filesystem: { [home]: "deny" },
        network: { enabled: false, allow_local_binding: false, enable_socks5: false },
      },
    });
    expect(started?.["sandbox"]).toBeUndefined();
    await expect(
      runtime.runPromise(threads.startTurn({ ...spec, sandboxProfile: undefined }, "no-binding", input)),
    ).rejects.toThrow("different sandbox profile or policy");
    await expect(
      runtime.runPromise(
        threads.startTurn(spec, "override", input, {
          model: "",
          effort: "",
          permissionMode: PermissionMode.FULL_ACCESS,
        }),
      ),
    ).rejects.toThrow("requires Sandbox mode");
    await runtime.runPromise(threads.startTurn(spec, "accepted", input));
    setScenario({ revision: "2" });
    await expect(runtime.runPromise(threads.startTurn(spec, "changed-layer", input))).rejects.toThrow(
      "different sandbox profile or policy",
    );
    expect(trace().filter((row) => row["method"] === "turn/start")).toEqual([
      { method: "turn/start", approvalPolicy: "never" },
    ]);
  } finally {
    await runtime.dispose();
  }
});

linuxTest("Codex refuses an unconfirmed cold resume and does not publish a ready session or send input", async () => {
  const { runtime, spec, events, trace } = fixture({ effectiveProfile: ":workspace" });
  spec.providerThreadId = crypto.randomUUID();

  try {
    const threads = await runtime.runPromise(CodexThreads);
    await expect(runtime.runPromise(threads.startTurn(spec, "cold", input))).rejects.toThrow(
      "did not confirm the requested effective sandbox profile",
    );
    expect(threads.has(spec.threadId)).toBe(false);
    expect(events).toEqual([]);
    expect(trace().map((entry) => entry["method"])).toContain("thread/unsubscribe");
    expect(trace().map((entry) => entry["method"])).not.toContain("turn/start");
  } finally {
    await runtime.dispose();
  }
});

linuxTest("Codex checks the named profile again on connector reconfiguration", async () => {
  const { runtime, spec, trace, setScenario } = fixture();

  try {
    const threads = await runtime.runPromise(CodexThreads);
    spec.providerThreadId = await runtime.runPromise(threads.create(spec));
    setScenario({ approvalPolicy: "on-request" });
    await expect(
      runtime.runPromise(threads.startTurn({ ...spec, enableMemory: true }, "refresh", input)),
    ).rejects.toThrow("did not confirm the requested effective sandbox profile");
    expect(trace().find((row) => row["method"] === "thread/resume")).toMatchObject({
      approvalPolicy: "never",
      permissions: `canopy_sandbox_${binding().digest}`,
    });
    expect(trace().map((row) => row["method"])).not.toContain("turn/start");
  } finally {
    await runtime.dispose();
  }
});

linuxTest("Codex admits domains only under the current exact managed-only policy", async () => {
  const { runtime, spec, trace, setScenario } = fixture();
  spec.sandboxProfile = binding(["allowed.example"]);

  const exact = {
    enabled: true,
    managedAllowedDomainsOnly: true,
    domains: { "allowed.example": "allow" },
    allowedDomains: ["allowed.example"],
  };

  try {
    const threads = await runtime.runPromise(CodexThreads);
    await expect(runtime.runPromise(threads.create(spec))).rejects.toThrow("active managed-only network allowlist");
    setScenario({ requirements: { network: { ...exact, allowedDomains: ["allowed.example", "*.extra.example"] } } });
    await expect(runtime.runPromise(threads.create(spec))).rejects.toThrow("must equal this sandbox profile");
    setScenario({ requirements: { network: { ...exact, allowLocalBinding: true } } });
    await expect(runtime.runPromise(threads.create(spec))).rejects.toThrow("permit additional network routes");
    setScenario({ requirements: { network: exact } });
    await runtime.runPromise(
      threads.create(
        spec,
        create(ForkSpecSchema, { sourceProviderThreadId: crypto.randomUUID(), afterProviderTurnRef: "old-turn" }),
      ),
    );
    expect(trace().filter((entry) => entry["method"] === "thread/start")).toEqual([]);
    expect(trace().find((entry) => entry["method"] === "thread/fork")).toMatchObject({
      approvalPolicy: "never",
      definition: { network: { enabled: true, allow_local_binding: false, enable_socks5: false } },
    });
  } finally {
    await runtime.dispose();
  }
});

linuxTest("A profiled command refuses a Codex executable that no longer matches a verified worker report", async () => {
  const { runtime, spec, trace } = fixture({ version: "0.164.0" });

  try {
    const threads = await runtime.runPromise(CodexThreads);
    await expect(runtime.runPromise(threads.create(spec))).rejects.toThrow(
      "has not verified custom command sandbox enforcement",
    );
    expect(trace().map((entry) => entry["method"])).toEqual(["initialize"]);
  } finally {
    await runtime.dispose();
  }
});

linuxTest("Codex resumes an empty rollout through a fresh restricted thread", async () => {
  const { runtime, spec, trace } = fixture({ emptyRollout: true });
  spec.providerThreadId = crypto.randomUUID();

  try {
    const threads = await runtime.runPromise(CodexThreads);
    await runtime.runPromise(threads.startTurn(spec, "recover-empty", input));
    expect(
      trace().filter((entry) => entry["method"] === "thread/start" || entry["method"] === "thread/resume"),
    ).toEqual([
      expect.objectContaining({ method: "thread/resume", permissions: `canopy_sandbox_${binding().digest}` }),
      expect.objectContaining({ method: "thread/start", permissions: `canopy_sandbox_${binding().digest}` }),
    ]);
  } finally {
    await runtime.dispose();
  }
});

linuxTest("Codex refuses an unqualified runtime or an enabled project config before native admission", async () => {
  const unqualified = fixture({}, false);
  const mixed = fixture({ layer: "project" });

  try {
    const first = await unqualified.runtime.runPromise(CodexThreads);
    const second = await mixed.runtime.runPromise(CodexThreads);
    await expect(unqualified.runtime.runPromise(first.create(unqualified.spec))).rejects.toThrow(
      "has not verified custom command sandbox enforcement",
    );
    await expect(mixed.runtime.runPromise(second.create(mixed.spec))).rejects.toThrow(
      "active project or managed configuration layer",
    );
    expect(unqualified.trace().map((entry) => entry["method"])).toEqual(["initialize"]);
    expect(mixed.trace().map((entry) => entry["method"])).not.toContain("thread/start");
  } finally {
    await Promise.all([unqualified.runtime.dispose(), mixed.runtime.dispose()]);
  }
});

linuxTest("Codex keeps a used session bound to its history when the rollout disappears", async () => {
  const { runtime, spec, trace } = fixture({ emptyRollout: true });
  spec.providerThreadId = crypto.randomUUID();

  try {
    const journal = await runtime.runPromise(Journal);
    await runtime.runPromise(
      journal.noteHarness(spec.threadId, "past-turn", {
        harness: "codex",
        transcript: "past-rollout",
        sessionId: spec.providerThreadId,
        offset: 0,
        providerTurn: "native-turn",
      }),
    );
    const threads = await runtime.runPromise(CodexThreads);
    await expect(runtime.runPromise(threads.startTurn(spec, "resume", input))).rejects.toThrow("session history");
    expect(trace().map((entry) => entry["method"])).not.toContain("thread/start");
  } finally {
    await runtime.dispose();
  }
});
