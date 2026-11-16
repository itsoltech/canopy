import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  CommandSchema,
  Provider,
  ProviderConfigurationMode,
  ProviderProfileKind,
  ThreadStorageCleanupRequestSchema,
  WorkerConfigSchema,
  type WorkerConfig,
} from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { Effect, ManagedRuntime } from "effect";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyWorkerConfig } from "../config/remote.ts";
import { Journal, type StorageCleanupGrant } from "../journal/index.ts";
import { HostContext } from "./host-context.ts";
import { HostState } from "./host-state.ts";
import { WorkerStorageCleanup } from "./storage-cleanup.ts";
import { cleanupHome, validatedCleanupHome } from "./storage-cleanup-homes.ts";

const threadId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

function fixture(root = tempDir("canopy-cleanup-binding-"), codexSource = false) {
  const dataDir = join(root, "data");
  const runtime = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));

  const homes = {
    claude: join(root, "device-claude"),
    codex: codexSource ? join(dataDir, "codex-home") : join(root, "device-codex"),
  };

  const state = new HostState({ runtime, dataDir, clientVersion: "test", deviceHomes: homes });
  const ctx = new HostContext(state, { applyConfig: async () => ({}), sendPreviews: () => {} });
  const storage = new WorkerStorageCleanup(ctx);

  const configure = (profiles: WorkerConfig["profiles"] = []) => {
    const result = applyWorkerConfig(
      create(WorkerConfigSchema, { version: 1n, profiles }),
      { which: () => null, version: () => undefined, realDirectory: (path) => path },
      { dataDir, ...homes },
    );

    if (!result.applied) throw new Error("Expected valid fixture configuration");
    state.config = result.config;
  };

  configure();

  return { root, dataDir, runtime, state, ctx, storage, configure };
}

function file(path: string, text = "retained session") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);

  return path;
}

const scope = {
  threadId,
  provider: Provider.CLAUDE,
  providerProfileId: "selected",
  providerThreadIds: [sessionId],
};

function request(storage: WorkerStorageCleanup, grant = scope) {
  storage.accept(create(ThreadStorageCleanupRequestSchema, { requestId: crypto.randomUUID(), scopes: [grant] }));

  return storage.settled();
}

async function completed(f: ReturnType<typeof fixture>) {
  expect(await f.runtime.runPromise(Journal.use((j) => j.pendingStorageCleanup()))).toEqual([]);
  expect(await f.runtime.runPromise(Journal.use((j) => j.hasStorageCleanup(threadId)))).toBe(true);
  expect(existsSync(join(f.dataDir, "attachments", threadId))).toBe(false);
  expect(
    await f.storage.rejects(
      create(CommandSchema, { kind: { case: "createThread", value: { fork: { sourceThreadId: threadId } } } }),
    ),
  ).toBe(true);
}

test("shared history survives policy replacement and restart while platform cleanup finishes", async () => {
  const first = fixture();
  const source = join(first.dataDir, "homes", "claude-original");
  const native = file(join(source, "projects", "-project", `${sessionId}.jsonl`));
  const credentials = file(join(source, ".credentials.json"), "fixture credentials");
  file(join(first.dataDir, "attachments", threadId, "a.txt"));
  first.configure(
    create(WorkerConfigSchema, {
      profiles: [
        {
          id: "selected",
          providers: [Provider.CLAUDE],
          kind: ProviderProfileKind.NATIVE,
          disabled: true,
          userConfiguration: { mode: ProviderConfigurationMode.SHARED, sourcePath: source },
        },
      ],
    }).profiles,
  );

  try {
    await first.runtime.runPromise(Journal.use((j) => j.bindClaudeSessionHome(threadId, source)));
    // Hold the grant before restart, exactly as a worker with an admitted command does.
    first.state.admitting = 1;
    await request(first.storage);
    expect(await first.runtime.runPromise(Journal.use((j) => j.pendingStorageCleanup()))).toEqual([
      { ...scope, homePath: source },
    ]);
    expect(existsSync(native)).toBe(true);
  } finally {
    await first.runtime.dispose();
  }

  const next = fixture(first.root);
  const replacement = join(next.dataDir, "homes", "claude-replacement");
  const other = file(join(replacement, "projects", "-project", `${sessionId}.jsonl`), "other history");
  next.configure(
    create(WorkerConfigSchema, {
      profiles: [
        {
          id: "selected",
          providers: [Provider.CLAUDE],
          kind: ProviderProfileKind.NATIVE,
          disabled: true,
          shadowHomePath: replacement,
          userConfiguration: { mode: ProviderConfigurationMode.ISOLATED, sourcePath: join(next.root, "new-source") },
        },
      ],
    }).profiles,
  );

  try {
    expect(await cleanupHome(next.ctx, scope)).toBe(source);
    next.storage.tick();
    await next.storage.settled();
    await completed(next);
    expect(readFileSync(native, "utf8")).toBe("retained session");
    expect(readFileSync(other, "utf8")).toBe("other history");
    expect(readFileSync(credentials, "utf8")).toBe("fixture credentials");
  } finally {
    await next.runtime.dispose();
  }
});

test("old cleanup grants revalidate thread and import bindings after restart and profile removal", async () => {
  for (const binding of ["thread", "import", "conflict", "unbound"] as const) {
    const first = fixture();
    const original = join(first.dataDir, "homes", "claude-original");
    const wrong = join(first.dataDir, "homes", "claude-wrong");
    const native = file(join(original, "projects", "-project", `${sessionId}.jsonl`));
    const other = file(join(wrong, "projects", "-project", `${sessionId}.jsonl`));
    file(join(first.dataDir, "attachments", threadId, "a.txt"));
    const grant: StorageCleanupGrant = { ...scope, homePath: binding === "conflict" ? original : wrong };

    try {
      await first.runtime.runPromise(
        Journal.use((j) =>
          Effect.gen(function* () {
            if (binding === "thread" || binding === "conflict") yield* j.bindClaudeSessionHome(threadId, original);

            if (binding === "import" || binding === "conflict")
              yield* j.bindClaudeImportedSessionHome("selected", sessionId, binding === "conflict" ? wrong : original);
            yield* j.grantStorageCleanup(grant);
          }),
        ),
      );
    } finally {
      await first.runtime.dispose();
    }

    const next = fixture(first.root);

    try {
      expect(await validatedCleanupHome(next.ctx, grant)).toBe("");

      if (binding === "thread" || binding === "import") expect(await cleanupHome(next.ctx, scope)).toBe(original);
      next.storage.tick();
      await next.storage.settled();
      await completed(next);
      expect(existsSync(native)).toBe(true);
      expect(existsSync(other)).toBe(true);
    } finally {
      await next.runtime.dispose();
    }
  }
});

test("a current import source protects native files without blocking platform cleanup", async () => {
  const f = fixture(undefined, true);
  const codex = { ...scope, provider: Provider.CODEX, providerProfileId: "native" };

  const native = file(
    join(f.dataDir, "codex-home", "sessions", "2026", "11", "16", `rollout-date-${sessionId}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: sessionId } }) + "\n",
  );

  file(join(f.dataDir, "attachments", threadId, "a.txt"));

  try {
    await request(f.storage, codex);
    await completed(f);
    expect(existsSync(native)).toBe(true);
  } finally {
    await f.runtime.dispose();
  }
});
