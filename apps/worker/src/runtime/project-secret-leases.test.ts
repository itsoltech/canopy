import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  AgentToolCallSchema,
  AgentToolResultSchema,
  InteractionKind,
  InteractionRequestSchema,
  InteractionResponseSchema,
  ItemDeltaField,
  ItemStatus,
  ThreadEventSchema,
  ThreadSecretDeliverySchema,
  TurnOutcome,
  WelcomeSchema,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { ManagedRuntime } from "effect";
import type { GatewayLink } from "../gateway-link/index.ts";
import { HeadTracker } from "../git/heads.ts";
import { Journal, type ThreadEventInit } from "../journal/index.ts";
import { HostContext } from "./host-context.ts";
import { HostState } from "./host-state.ts";
import { WorkerHost } from "./host.ts";
import { projectSecretGuard } from "./project-secret-guard.ts";
import { ProjectSecretTurns } from "./project-secret-turns.ts";
import { ThreadSecretFiles, threadSecretOutputGuard } from "./thread-secrets.ts";
import { applyLinkSecretDelivery } from "./session.ts";

const temp = tempDirs();

function setup() {
  const dataDir = temp("canopy-project-secret-");
  const cwd = join(dataDir, "workspace");
  mkdirSync(cwd);
  const threadId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const value = `synthetic-${crypto.randomUUID()}"\nsecret`;

  const delivery = create(ThreadSecretDeliverySchema, {
    threadId,
    turnId,
    requestId: crypto.randomUUID(),
    revision: 1,
    cwd,
    value,
    expiresAt: timestampFromDate(new Date(Date.now() + 60_000)),
  });

  return { dataDir, delivery, threadId, turnId, value };
}

function mockLink(send: GatewayLink["send"]): GatewayLink {
  return {
    welcome: create(WelcomeSchema),
    messages: { async *[Symbol.asyncIterator]() {} },
    closed: Promise.withResolvers<Awaited<GatewayLink["closed"]>>().promise,
    close: () => {},
    send,
  };
}

test("leases require the live turn and session, and reset rejects stale receipts and deliveries", () => {
  const { dataDir, delivery, threadId, turnId, value } = setup();
  const files = new ThreadSecretFiles(dataDir);
  const guard = projectSecretGuard(threadId);
  const stale = projectSecretGuard(threadId);
  const foreign = projectSecretGuard(crypto.randomUUID());
  const path = join(files.root, threadId, delivery.requestId);

  try {
    guard.ready();
    expect(files.apply(delivery)).toMatchObject({ turnId, rejected: true, applied: false, file: "" });
    guard.reset();
    files.beginProjectTurn(threadId, turnId);
    stale.ready();
    expect(files.apply(delivery).rejected).toBe(true);
    expect(existsSync(path)).toBe(false);

    // A new turn can use the verified replacement while the old turn ID remains ineligible.
    files.finishProjectTurn(threadId, turnId);
    const nextTurn = crypto.randomUUID();
    files.beginProjectTurn(threadId, nextTurn);
    guard.ready();

    expect(files.apply(delivery).rejected).toBe(true);
    expect(files.apply({ ...delivery, turnId: nextTurn })).toMatchObject({
      turnId: nextTurn,
      applied: true,
      rejected: false,
      file: path,
    });
    expect(readFileSync(path, "utf8") === value).toBe(true);

    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(guard.redact(JSON.stringify({ output: value }))).toBe('{"output":"[REDACTED]"}');
    expect(foreign.redact(value) === value).toBe(true);

    guard.reset();
    expect(files.projectFileAvailable(threadId, nextTurn, path)).toBe(false);
    expect(existsSync(path)).toBe(false);
    guard.ready();
    expect(files.apply({ ...delivery, turnId: nextTurn }).rejected).toBe(true);
    expect(guard.redact(value)).toBe("[REDACTED]");
  } finally {
    files.close();
  }
});

test("replacing an old filter after turn admission only fences turns with a request or a file", () => {
  const { dataDir, delivery, threadId, turnId } = setup();
  const files = new ThreadSecretFiles(dataDir);
  const previous = projectSecretGuard(threadId);

  try {
    previous.ready();
    files.beginProjectTurn(threadId, turnId);
    previous.reset();

    const current = projectSecretGuard(threadId);
    current.ready();
    expect(files.apply(delivery).applied).toBe(true);

    const nextTurn = crypto.randomUUID();
    files.beginProjectTurn(threadId, nextTurn);
    const pending = files.requestProjectTurnSignal(threadId, nextTurn);
    expect(pending?.aborted).toBe(false);
    current.reset();
    expect(pending?.aborted).toBe(true);

    const replacement = projectSecretGuard(threadId);
    replacement.ready();
    expect(files.apply({ ...delivery, turnId: nextTurn }).rejected).toBe(true);
  } finally {
    files.close();
  }
});

test("thread output masking includes manual files independently of project filter readiness", () => {
  const { dataDir, delivery, threadId, value } = setup();
  const files = new ThreadSecretFiles(dataDir);
  const project = projectSecretGuard(threadId);
  const local = threadSecretOutputGuard(threadId);
  const foreign = threadSecretOutputGuard(crypto.randomUUID());

  try {
    expect(files.apply({ ...delivery, turnId: "" }).applied).toBe(true);
    expect(project.isReady()).toBe(false);
    expect(project.hasValues()).toBe(false);
    expect(local.hasValues()).toBe(true);
    expect(local.redact(value)).toBe("[REDACTED]");
    expect(foreign.hasValues()).toBe(false);
  } finally {
    files.close();
  }
});

test("project requests fail locally when unsafe, fence delayed replies, and keep ordinary waits on reconnect", async () => {
  const { dataDir, delivery, threadId, turnId, value } = setup();
  const runtime = ManagedRuntime.make(Journal.layer(join(dataDir, "journal.db")));
  const state = new HostState({ runtime, dataDir, clientVersion: "test" });
  state.heads = new HeadTracker(() => {});
  const { ops } = new HostContext(state, { applyConfig: async () => ({}), sendPreviews: () => {} });
  const sent: string[] = [];
  const permissions: string[] = [];

  const link = mockLink((payload) => {
    if (payload.case === "agentToolCall" && payload.value.callId) sent.push(payload.value.callId);

    if (payload.case === "interactionRequest" && payload.value.requestJson) permissions.push(payload.value.requestJson);
  });

  const call = (
    args: { project_secret: string } | { label: string; description: string } = {
      project_secret: "PROJECT_KEY",
    },
  ) =>
    create(AgentToolCallSchema, {
      callId: crypto.randomUUID(),
      toolName: "request_secret",
      argumentsJson: JSON.stringify(args),
      threadId,
      turnId,
    });

  state.link = link;
  const guard = projectSecretGuard(threadId);

  const started = await runtime.runPromise(
    Journal.use((j) => j.append(threadId, { turnId, body: { case: "turnStarted", value: {} } })),
  );

  try {
    ops.publish(started);
    expect(await ops.callTool(call())).toMatchObject({ isError: true });
    expect(sent).toEqual([]);
    guard.ready();
    const first = call();
    const waiting = ops.callTool(first);
    expect(sent).toEqual([first.callId]);

    // The gateway already bound the new checkout, while the active harness still sees the secret store in its cwd.
    state.cwds.set(threadId, dataDir);
    state.nextWorkspaces.set(threadId, delivery.cwd);
    expect(applyLinkSecretDelivery(state, link, delivery).rejected).toBe(true);
    state.cwds.set(threadId, delivery.cwd);
    state.nextWorkspaces.delete(threadId);
    const receipt = applyLinkSecretDelivery(state, link, delivery);
    expect(receipt.applied).toBe(true);
    const saved = JSON.stringify({ status: "saved", file: receipt.file });

    ops.toolResult(create(AgentToolResultSchema, { callId: first.callId, content: saved }));
    expect((await waiting).content).toBe(saved);

    const requestId = crypto.randomUUID();
    const requestJson = JSON.stringify({ input: { command: `cat "${receipt.file}"`, detail: value } });

    const request = create(InteractionRequestSchema, {
      requestId,
      threadId,
      turnId,
      kind: InteractionKind.PERMISSION,
      requestJson,
    });

    const approval = ops.interact(request);
    const safeJson = JSON.stringify({ input: { command: 'cat "[REDACTED]"', detail: "[REDACTED]" } });

    expect(permissions).toEqual([safeJson]);
    expect(state.interactions.get(requestId)?.request.requestJson).toBe(safeJson);
    expect(request.requestJson === requestJson).toBe(true);
    state.interactions.get(requestId)?.resolve(create(InteractionResponseSchema, { requestId, allow: true }));
    state.interactions.delete(requestId);
    expect((await approval).allow).toBe(true);

    const sharePath = create(AgentToolCallSchema, {
      ...call(),
      toolName: "send_message",
      argumentsJson: JSON.stringify({ prompt: receipt.file }),
    });

    expect(await ops.callTool(sharePath)).toMatchObject({ isError: true });
    expect(sent).toEqual([first.callId]);

    const late = call();
    const revoked = ops.callTool(late);
    expect(state.secrets.apply({ ...delivery, remove: true, revision: 2 }).applied).toBe(true);
    expect(state.secrets.apply(delivery).rejected).toBe(true);
    ops.toolResult(create(AgentToolResultSchema, { callId: late.callId, content: saved }));
    expect(await revoked).toMatchObject({ isError: true });

    const other = state.secrets.apply({ ...delivery, requestId: crypto.randomUUID() });
    expect(other.applied).toBe(true);
    const disconnected = call();
    const pending = ops.callTool(disconnected);
    const manual = call({ label: "Ordinary", description: "A personal passphrase" });
    const ordinaryPending = ops.callTool(manual);
    expect(ops.detachGateway(link)).toBe(true);
    expect(await pending).toMatchObject({ isError: true });
    expect(existsSync(other.file)).toBe(false);
    expect([...state.toolCalls.keys()]).toEqual([manual.callId]);
    state.link = mockLink(() => {});
    expect(state.secrets.apply(delivery).rejected).toBe(true);
    ops.toolResult(create(AgentToolResultSchema, { callId: disconnected.callId, content: saved }));
    expect(await ops.callTool(call())).toMatchObject({ isError: true });
    expect(guard.redact(value)).toBe("[REDACTED]");

    ops.toolResult(create(AgentToolResultSchema, { callId: manual.callId, content: "ordinary result" }));
    expect((await ordinaryPending).content).toBe("ordinary result");
  } finally {
    state.heads.close();
    state.secrets.close();
    await runtime.dispose();
  }
});

test("leases expire offline and a local TTL cannot reapply the same revision", async () => {
  const { dataDir, delivery, threadId, turnId, value } = setup();
  const files = new ThreadSecretFiles(dataDir);
  const guard = projectSecretGuard(threadId);

  try {
    files.beginProjectTurn(threadId, turnId);
    guard.ready();

    const receipt = files.apply({
      ...delivery,
      expiresAt: timestampFromDate(new Date(Date.now() + 100)),
    });

    expect(receipt.applied).toBe(true);
    const deadline = Date.now() + 1_000;

    while (existsSync(receipt.file) && Date.now() < deadline) await Bun.sleep(10);

    expect(existsSync(receipt.file)).toBe(false);
    expect(files.apply(delivery).rejected).toBe(true);
    expect(files.apply({ ...delivery, revision: 2 }).rejected).toBe(true);
    expect(guard.redact(value)).toBe("[REDACTED]");
    files.finishProjectTurn(threadId, turnId);
    expect(files.apply(delivery).rejected).toBe(true);
    expect(guard.redact(value)).toBe("[REDACTED]");
  } finally {
    files.close();
  }
});

test("patterns survive the foreground turn while its background task is still producing output", async () => {
  const threadId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const value = `synthetic-${crypto.randomUUID()}`;
  const drainMs = 20;
  const turns = new ProjectSecretTurns(() => {}, drainMs);
  const guard = projectSecretGuard(threadId);

  try {
    turns.begin(threadId, turnId);
    turns.add(threadId, turnId, value);
    turns.background(threadId, turnId, "bg:process", true);
    turns.finish(threadId, turnId);
    turns.begin(threadId, crypto.randomUUID());
    // The original turn's ordinary drain deadline has passed, while its task is still live.
    await Bun.sleep(drainMs * 2);
    expect(guard.redact(value)).toBe("[REDACTED]");

    turns.background(threadId, "", "bg:process", false);
    expect(guard.redact(value)).toBe("[REDACTED]");
    const deadline = Date.now() + 1_000;

    while (guard.hasValues() && Date.now() < deadline) await Bun.sleep(5);

    expect(guard.hasValues()).toBe(false);
  } finally {
    turns.close();
  }
});

test("restart deletes lease files, recovers outcomes, and keeps private transcript content out of the journal", async () => {
  const { dataDir, delivery, threadId, turnId, value } = setup();
  const nativeSession = crypto.randomUUID();
  const profile = join(dataDir, "provider");
  const transcripts = join(profile, "projects", "workspace");
  mkdirSync(transcripts, { recursive: true });
  const plainTurn = crypto.randomUUID();
  const plainSession = crypto.randomUUID();

  const transcript = (id: string, output: string) =>
    writeFileSync(
      join(transcripts, `${id}.jsonl`),
      JSON.stringify({
        type: "assistant",
        message: { id: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: output }] },
      }) + "\n",
    );

  transcript(nativeSession, value);
  transcript(plainSession, "safe recovery output");

  const journalPath = join(dataDir, "journal.db");
  const first = ManagedRuntime.make(Journal.layer(journalPath));

  const host = new WorkerHost({
    runtime: first,
    dataDir,
    clientVersion: "test",
    cliEnv: { HOME: dataDir, PATH: join(dataDir, "bin") },
    cliProbe: {
      platform: process.platform,
      home: dataDir,
      docker: false,
      locate: () => [],
      which: () => null,
      realpath: () => undefined,
      version: async () => ({ error: "Unavailable" }),
    },
  });

  const cliReport = Promise.withResolvers<void>();
  const toolsReport = Promise.withResolvers<void>();

  const link = mockLink((payload) => {
    if (payload.case === "cliTools") cliReport.resolve();

    if (payload.case === "agentToolsReport") toolsReport.resolve();
  });

  const projectTool = projectSecretGuard(threadId);
  let receiptFile = "";

  try {
    host.attach(link);
    await Promise.all([cliReport.promise, toolsReport.promise]);

    for (const [turn, sessionId] of [
      [turnId, nativeSession],
      [plainTurn, plainSession],
    ] as const) {
      await first.runPromise(
        Journal.use((j) => j.append(threadId, { turnId: turn, body: { case: "turnStarted", value: {} } })),
      );
      await first.runPromise(
        Journal.use((j) =>
          j.noteHarness(threadId, turn, {
            harness: "claude",
            transcript: profile,
            sessionId,
            offset: 0,
            providerTurn: "",
          }),
        ),
      );
    }

    host.secrets.beginProjectTurn(threadId, turnId);
    projectTool.ready();
    const receipt = host.applySecretDelivery(link, delivery);
    expect(receipt.applied).toBe(true);
    receiptFile = receipt.file;
    expect(await first.runPromise(Journal.use((j) => j.hasProjectSecretHistory(threadId, nativeSession)))).toBe(true);
    expect(await first.runPromise(Journal.use((j) => j.hasProjectSecretHistory(threadId, plainSession)))).toBe(false);

    const append = (event: ThreadEventInit) =>
      first.runPromise(Journal.use((j) => j.append(threadId, { turnId, ...event })));

    const itemId = "stream";

    const delta = (chunk: string) =>
      append({
        rawJson: JSON.stringify({ chunk }),
        body: { case: "itemDelta", value: { itemId, field: ItemDeltaField.OUTPUT, chunk } },
      });

    await delta(value.slice(0, 7));
    await delta(value.slice(7));

    const event = await append({
      body: {
        case: "itemCompleted",
        value: { item: { itemId, status: ItemStatus.COMPLETED, content: { case: "commandExecution", value: {} } } },
      },
    });

    expect(event.body).toMatchObject({
      case: "itemCompleted",
      value: { item: { content: { value: { output: "[REDACTED]" } } } },
    });

    const result = JSON.stringify({ name: "PROJECT_KEY", request_id: delivery.requestId, file: receipt.file });

    const busItem = await append({
      rawJson: result,
      body: {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "platform-tool",
            content: {
              case: "agentBusCall",
              value: {
                toolName: "request_secret",
                argumentsJson: '{"project_secret":"PROJECT_KEY"}',
                resultJson: result,
              },
            },
          },
        },
      },
    });

    expect(busItem.rawJson).toBe("");
    expect(busItem.body).toMatchObject({
      value: { item: { content: { value: { argumentsJson: "{}", resultJson: "" } } } },
    });

    const pathMention = await append({
      body: { case: "notice", value: { message: receipt.file } },
    });

    expect(pathMention.body).toMatchObject({ value: { message: "[REDACTED]" } });
    expect(projectTool.redact(receipt.file)).toBe(receipt.file);
    await append({
      body: {
        case: "itemStarted",
        value: {
          item: {
            itemId: "bg:late",
            status: ItemStatus.IN_PROGRESS,
            content: { case: "backgroundTask", value: { startedInTurnId: turnId } },
          },
        },
      },
    });
  } finally {
    await host.close();
    await first.dispose();
  }

  // Simulate a private file left behind by abrupt exit.
  mkdirSync(join(receiptFile, ".."), { recursive: true });
  writeFileSync(receiptFile, value, { mode: 0o600 });
  const second = ManagedRuntime.make(Journal.layer(journalPath));
  const restarted = new WorkerHost({ runtime: second, dataDir, clientVersion: "test" });

  try {
    expect(existsSync(receiptFile)).toBe(false);
    expect(projectTool.hasValues()).toBe(false);

    const backgroundDelta = await second.runPromise(
      Journal.use((j) =>
        j.append(threadId, {
          turnId: plainTurn,
          rawJson: value,
          body: { case: "itemDelta", value: { itemId: "bg:late", field: ItemDeltaField.OUTPUT, chunk: value } },
        }),
      ),
    );

    expect(backgroundDelta.rawJson).toBe("");
    expect(backgroundDelta.body).toMatchObject({ value: { chunk: "" } });
    expect(await restarted.recover()).toMatchObject({ turns: 2, fromTranscript: 2 });
    expect(await second.runPromise(Journal.use((j) => j.hasProjectSecretHistory(threadId, nativeSession)))).toBe(true);

    const late = await second.runPromise(
      Journal.use((j) =>
        j.append(threadId, {
          turnId,
          rawJson: value,
          body: {
            case: "itemCompleted",
            value: {
              item: {
                itemId: "late",
                content: { case: "agentMessage", value: { text: value } },
              },
            },
          },
        }),
      ),
    );

    expect(late.rawJson).toBe("");
    expect(late.body).toMatchObject({
      value: { item: { itemId: "late", content: { value: { text: "[REDACTED]" } } } },
    });
    const events = await second.runPromise(Journal.use((j) => j.pending(new Map())));
    const completed = events.filter((event) => event.body.case === "turnFinished");
    expect(completed).toHaveLength(2);
    expect(
      completed.every(
        (event) => event.body.case === "turnFinished" && event.body.value.outcome === TurnOutcome.COMPLETED,
      ),
    ).toBe(true);
    const text = events.map((event) => toJsonString(ThreadEventSchema, event)).join("\n");
    expect(text).toContain("safe recovery output");
    expect(text.includes(JSON.stringify(value).slice(1, -1))).toBe(false);
  } finally {
    await restarted.close();
    await second.dispose();
  }
});
