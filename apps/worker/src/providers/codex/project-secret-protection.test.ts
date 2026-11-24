import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadSpecSchema,
  TurnOutcome,
  UserInputSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Effect, Layer, Schema } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "../../journal/index.ts";
import { bindProjectSecretFilter, projectSecretGuard } from "../../runtime/project-secret-guard.ts";
import { resolveProfiles } from "../profiles.ts";
import { codexAppServerLaunch } from "./launch.ts";
import { CodexThreads } from "./threads.ts";

const temp = tempDirs();
const shell = process.platform !== "win32" && Bun.which("curl");
const codex = Bun.which("codex");

const ModelInput = Schema.Struct({
  input: Schema.Array(Schema.Struct({ type: Schema.String, output: Schema.optionalKey(Schema.Json) })),
});

function outputs(body: string | undefined) {
  if (!body) return "";

  return JSON.stringify(
    Schema.decodeUnknownSync(ModelInput)(JSON.parse(body)).input.flatMap((item) =>
      item.type.endsWith("_call_output") ? [item.output] : [],
    ),
  );
}

const functionCall = (name: string, args: Record<string, string | number>) => ({
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
});

function toolSteps(mode: "classic" | "code") {
  if (mode === "code")
    return [
      () => ({
        type: "custom_tool_call",
        name: "exec",
        input: 'text(await tools.exec_command({cmd:"cat payload; sleep 2; echo end",yield_time_ms:1000}));',
      }),
    ];

  return [
    () => functionCall("exec_command", { cmd: 'cat payload; printf " PUBLIC_COMPLETE"' }),
    () =>
      functionCall("exec_command", {
        cmd: 'cat payload; printf " PUBLIC_START"; sleep 2; cat payload; printf " PUBLIC_POLL"; sleep 4',
        yield_time_ms: 1000,
      }),
    (body: string) =>
      functionCall("write_stdin", {
        session_id: Number(/Process running with session ID (\d+)/.exec(outputs(body))?.[1]),
        chars: "",
        yield_time_ms: 3000,
      }),
    () => functionCall("exec_command", { cmd: 'cat payload >&2; echo "Operation not permitted" >&2; exit 1' }),
  ];
}

function mockModel(mode: "classic" | "code", grant: () => Promise<void>) {
  const requests: string[] = [];
  const keys: (string | null)[] = [];
  let upgrades = 0;
  const steps = toolSteps(mode);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.headers.has("upgrade")) upgrades++;

      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses")
        return new Response(null, { status: 404 });
      const body = await request.text();
      const i = requests.push(body);
      keys.push(request.headers.get("authorization"));

      if (i === 2) await grant();
      const call = steps[i - 2]?.(body);

      const item = call
        ? { ...call, id: `fixture-tool-${i}`, call_id: `call-${i}` }
        : {
            type: "message",
            id: "answer",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done", annotations: [] }],
          };

      const frames = [
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `fixture-response-${i}`,
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];

      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  return { url: server.url.href, requests, keys, upgrades: () => upgrades, stop: () => server.stop(true) };
}

for (const mode of ["classic", "code"] as const)
  test.skipIf(!codex || !shell)(
    `Codex ${mode} model requests redact protected shell results before upstream inference`,
    async () => {
      const dir = temp("canopy-codex-project-secret-");
      const cwd = join(dir, "project");
      const nextCwd = join(dir, "new-worktree");
      mkdirSync(cwd);
      mkdirSync(nextCwd);

      const spec = create(ThreadSpecSchema, {
        threadId: crypto.randomUUID(),
        provider: Provider.CODEX,
        cwd: mode === "classic" ? cwd : nextCwd,
        model: mode === "classic" ? "gpt-5.5" : "gpt-6.1-sol",
        permissionMode: PermissionMode.FULL_AUTO,
        enableAgentBus: true,
        enableWorktreeSwitch: true,
        projectSecretsConfigured: mode === "code",
      });

      const ordinaryTurnId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const nextTurnId = crypto.randomUUID();
      const guard = () => projectSecretGuard(spec.threadId);
      const synthetic = `SYNTHETIC_CODEX_${crypto.randomUUID()}`;
      const values = new Set<string>();

      const unbind = bindProjectSecretFilter(spec.threadId, {
        values: () => values,
        retains: (id) => id === turnId && values.size > 0,
        fence: () => rmSync(join(cwd, "payload"), { force: true }),
      });

      const admitted = Promise.withResolvers<void>();
      const ordinary = Promise.withResolvers<ThreadEvent>();
      const end = Promise.withResolvers<ThreadEvent>();
      const next = Promise.withResolvers<ThreadEvent>();
      const replacements: string[] = [];
      let mark: (() => Promise<boolean>) | undefined;

      const model = mockModel(mode, async () => {
        await admitted.promise;

        if (!guard().isReady() || !(await mark?.())) return;
        values.add(synthetic);
        writeFileSync(join(cwd, "payload"), synthetic, { mode: 0o600 });
      });

      const profile = resolveProfiles([
        {
          id: "mock",
          kind: "cliproxyapi",
          baseUrl: model.url,
          apiKey: "fixture",
          providers: ["codex"],
          ...(mode === "code" && { codex: { supportsWebsockets: true, wireApi: "responses", extraHeaders: {} } }),
        },
      ]).find((entry) => entry.config.id === "mock")!.resolved!;

      const layer = CodexThreads.layer({
        launch: codexAppServerLaunch(
          [profile],
          { PATH: process.env["PATH"], HOME: dir },
          codex!,
          undefined,
          dir,
          {},
          mode === "code" ? ["-c", "features.code_mode_only=true"] : [],
        ),
        clientVersion: "test",
        profile: () => profile,
        publish: (event) => {
          if (event.turnId === ordinaryTurnId && event.body.case === "turnFinished") ordinary.resolve(event);

          if (event.turnId === turnId && event.body.case === "turnStarted") admitted.resolve();

          if (event.turnId === turnId && event.body.case === "turnFinished") end.resolve(event);

          if (event.turnId === nextTurnId && event.body.case === "turnFinished") next.resolve(event);

          if (event.body.case === "threadReady" && event.body.value.replacesProviderThreadId)
            replacements.push(event.body.value.replacesProviderThreadId);
        },
        interact: async () => create(InteractionResponseSchema, { allow: false }),
        callTool: async () => create(AgentToolResultSchema, { isError: true }),
      }).pipe(Layer.provideMerge(Journal.layer(join(dir, "journal.db"))));

      const continueThread = Effect.gen(function* () {
        const threads = yield* CodexThreads;
        values.clear();

        if (mode === "classic") spec.projectSecretsConfigured = false;
        yield* threads.startTurn(
          { ...spec, cwd: nextCwd },
          nextTurnId,
          create(UserInputSchema, { text: "Continue from the safe session." }),
        );

        return yield* Effect.promise(() => next.promise);
      });

      try {
        const finished = await Effect.runPromise(
          Effect.gen(function* () {
            const threads = yield* CodexThreads;
            const journal = yield* Journal;
            mark = () => Effect.runPromise(journal.markProjectSecretTurn(spec.threadId, turnId));
            spec.providerThreadId = yield* threads.create(spec);

            yield* threads.startTurn(
              spec,
              ordinaryTurnId,
              create(UserInputSchema, { text: "Before the first project secret grant." }),
            );
            const first = yield* Effect.promise(() => ordinary.promise);

            expect(first.body.value).toMatchObject({ outcome: TurnOutcome.COMPLETED });
            expect(guard().isReady()).toBe(spec.projectSecretsConfigured);
            // Classic enables protection in place; code mode moves an already protected session.
            spec.projectSecretsConfigured = true;
            spec.cwd = cwd;

            yield* threads.startTurn(spec, turnId, create(UserInputSchema, { text: "Read the fixture" }));
            const finished = yield* Effect.promise(() => end.promise);

            if (mode === "classic") {
              expect(guard().isReady()).toBe(false);
              expect(values.size).toBe(1);
              expect((yield* continueThread).body.value).toMatchObject({ outcome: TurnOutcome.COMPLETED });
            }

            return finished;
          }).pipe(Effect.provide(layer), Effect.timeout("25 seconds")),
        );

        expect(finished.body.value).toMatchObject({ outcome: TurnOutcome.COMPLETED });

        if (mode === "code") {
          expect(values.size).toBe(1);

          const resumed = await Effect.runPromise(
            continueThread.pipe(Effect.provide(layer), Effect.timeout("10 seconds")),
          );

          expect(resumed.body.value).toMatchObject({ outcome: TurnOutcome.COMPLETED });
        }

        expect(guard().isReady()).toBe(false);
        expect(replacements).toEqual([spec.providerThreadId]);
        expect(model.requests).toHaveLength(mode === "classic" ? 7 : 4);
        expect(model.upgrades()).toBe(0);
        expect(model.keys.every((key) => key === "Bearer fixture")).toBe(true);
        expect(model.requests.every((request) => !request.includes(synthetic))).toBe(true);
        expect(outputs(model.requests.at(-2)).includes("[REDACTED]")).toBe(true);
        expect(outputs(model.requests.at(-1))).toBe("[]");
        expect(model.requests.at(-1)).toContain("Continue from the safe session.");
        expect(model.requests.at(-1)).toContain(nextCwd);
        expect(model.requests[1]).toContain("Before the first project secret grant.");

        if (mode === "classic") {
          expect(outputs(model.requests[2])).toContain("A project secret was redacted from the tool result.");
          expect(outputs(model.requests[2])).toContain("[REDACTED] PUBLIC_COMPLETE");
          expect(outputs(model.requests[3])).toContain("[REDACTED] PUBLIC_START");
          expect(outputs(model.requests[4])).toContain("[REDACTED] PUBLIC_POLL");
          expect(outputs(model.requests[5])).toContain("[REDACTED]Operation not permitted");
        }
      } finally {
        unbind();
        admitted.resolve();
        await model.stop();
      }
    },
    30_000,
  );
