import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { ImportPageSchema, ImportScanSchema, ReadImportPageSchema, type ImportPage } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { tempDirs } from "@canopy/testing";
import { installFixtureHome } from "./fixtures/install.ts";
import { HIDDEN, Masker, maskJson, maskText } from "./masking.ts";
import { readImportPage } from "./pages.ts";
import { WorkerImport } from "./service.ts";

/**
 * Security tests for masking (docs/import.md, "Maskowanie"): a private key that a CLI wrote in parts (streamed
 * chunks, content blocks, content parts) cannot be read back from what leaves the worker, in any of the three CLIs.
 */

const temp = tempDirs();

/** A real RSA key, split into its header, body lines and footer. */
function splitKey() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  const lines = privateKey.trim().split("\n");
  const header = `${lines[0]!}\n`;
  const footer = lines.at(-1)!;
  const body = `${lines.slice(1, -1).join("\n")}\n`;
  // Parts as a CLI streams them: the header alone, the body cut at odd places, the footer.
  const third = Math.floor(body.length / 3) + 5;

  return { key: privateKey, header, footer, body, parts: [header, body.slice(0, third), body.slice(third), footer] };
}

/** Pieces of the key's body that must not appear anywhere, with line breaks and JSON escapes taken out. */
function readable(output: string, body: string): string[] {
  const flat = output.replaceAll("\\n", "").replace(/\s+/g, "");
  const material = body.replace(/\s+/g, "");
  const pieces: string[] = [];

  for (let at = 0; at + 16 <= material.length; at += 8) {
    const piece = material.slice(at, at + 16);

    if (flat.includes(piece)) pieces.push(piece);
  }

  return pieces;
}

function setup() {
  const root = temp("canopy-import-split-");
  const home = join(root, "home");
  installFixtureHome(home);

  const service = new WorkerImport({
    dataDir: join(root, "data"),
    homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
    config: () => undefined,
  });

  return { home, service };
}

/** Every page of a thread and the scan that lists it, as the worker sends them. */
async function sent(service: WorkerImport, nativeId: string): Promise<string> {
  const scan = await service.scan([]);
  const summary = scan.threads.find((t) => t.nativeId === nativeId)!;
  const pages: ImportPage[] = [];
  let cursor = "";

  for (;;) {
    const page = readImportPage(
      service,
      create(ReadImportPageSchema, {
        sourceKey: summary.sourceKey,
        snapshot: summary.snapshot,
        cursor,
        threadId: crypto.randomUUID(),
      }),
    );

    pages.push(page);
    cursor = page.nextCursor;

    if (page.done) break;
  }

  return [
    toJsonString(ImportScanSchema, create(ImportScanSchema, scan)),
    ...pages.map((p) => toJsonString(ImportPageSchema, p)),
  ].join("\n");
}

test("Grok: a key streamed in prompt, answer and thinking chunks cannot be read back", async () => {
  const { home, service } = setup();
  const { parts, body } = splitKey();
  const id = "01a1b2ac-0000-7000-8000-0000000000a1";
  const dir = join(home, ".grok", "sessions", encodeURIComponent(join(home, "project")), id);
  mkdirSync(dir, { recursive: true });

  const update = (u: JsonObject, method = "session/update") => `${JSON.stringify({ method, params: { update: u } })}\n`;

  const chunks = (kind: string) =>
    parts.map((text) => update({ sessionUpdate: kind, content: { type: "text", text } })).join("");

  writeFileSync(
    join(dir, "updates.jsonl"),
    chunks("user_message_chunk") +
      chunks("agent_thought_chunk") +
      chunks("agent_message_chunk") +
      update({ sessionUpdate: "turn_completed", stop_reason: "end_turn" }, "_x.ai/session/update"),
  );

  const output = await sent(service, id);

  expect(readable(output, body)).toEqual([]);
  // The rest of the conversation is still there: the turn and its steps.
  expect(output).toContain("agentMessage");
});

test("Grok chat history: a key in a message's content parts cannot be read back", async () => {
  const { home, service } = setup();
  const { parts, body } = splitKey();
  const id = "01a1b2ac-0000-7000-8000-0000000000a2";
  const dir = join(home, ".grok", "sessions", encodeURIComponent(join(home, "project")), id);
  mkdirSync(dir, { recursive: true });
  const content = parts.map((text) => ({ type: "text", text }));

  writeFileSync(
    join(dir, "chat_history.jsonl"),
    [
      { type: "user", prompt_index: 0, content },
      { type: "assistant", content },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );

  expect(readable(await sent(service, id), body)).toEqual([]);
});

test("Claude: a key in a prompt's parts and across one message's blocks (separate entries) cannot be read back", async () => {
  const { home, service } = setup();
  const { parts, body } = splitKey();
  const id = crypto.randomUUID();
  const project = join(home, ".claude", "projects", home.replace(/[^a-zA-Z0-9]/g, "-") + "-project");
  const base = { sessionId: id, cwd: join(home, "project"), version: "2.1.308", timestamp: new Date().toISOString() };
  const prompt = parts.map((text) => ({ type: "text", text }));

  const entries: JsonObject[] = [
    { ...base, type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: prompt } },
    // Claude Code writes each block of one message as its own entry.
    ...parts.flatMap((text, i) => [
      {
        ...base,
        type: "assistant",
        uuid: `t${i}`,
        parentUuid: i === 0 ? "u1" : `a${i - 1}`,
        message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: text }] },
      },
      {
        ...base,
        type: "assistant",
        uuid: `a${i}`,
        parentUuid: `t${i}`,
        message: { id: "m1", role: "assistant", content: [{ type: "text", text }] },
      },
    ]),
  ];

  writeFileSync(join(project, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const output = await sent(service, id);

  expect(readable(output, body)).toEqual([]);
  expect(output).toContain(HIDDEN);
});

test("Codex: a key in a message's content parts cannot be read back", async () => {
  const { home, service } = setup();
  const { parts, body } = splitKey();
  const id = crypto.randomUUID();
  const dir = join(home, ".codex", "sessions", "2025", "06", "03");
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.UTC(2025, 5, 3, 10)).toISOString();
  const rec = (type: string, payload: JsonObject) => `${JSON.stringify({ timestamp: at, type, payload })}\n`;

  writeFileSync(
    join(dir, `rollout-2025-06-03T10-00-00-${id}.jsonl`),
    rec("session_meta", { id, cwd: join(home, "project"), cli_version: "0.30.0" }) +
      rec("event_msg", { type: "user_message", message: "Show the key" }) +
      rec("response_item", {
        type: "message",
        role: "assistant",
        content: parts.map((text) => ({ type: "output_text", text })),
      }) +
      rec("response_item", { type: "reasoning", summary: parts.map((text) => ({ type: "summary_text", text })) }),
  );

  expect(readable(await sent(service, id), body)).toEqual([]);
});

test("native copies: a key split across a record's strings, a credential used as a key, a masked sibling", () => {
  const { parts, body } = splitKey();
  const secret = "copy-credential-CANARY-0042";
  const masker = new Masker([secret]);

  const split = maskJson({ message: { content: parts.map((text) => ({ type: "text", text })) } }, masker, () => {});
  expect(readable(JSON.stringify(split), body)).toEqual([]);

  // A known credential as an object key is masked like a value.
  expect(JSON.stringify(maskJson({ [secret]: "value", other: { [secret]: 1 } }, masker, () => {}))).not.toContain(
    "CANARY",
  );

  // One field masked does not skip the check of the whole text: a secret behind an escape elsewhere is still found.
  const escaped = JSON.stringify(secret).slice(1, -1).replace("C", "\\u0043");
  const text = JSON.stringify({ a: secret, b: `run "${escaped}"` });
  expect(maskText(text, masker)).not.toContain("CANARY");
  expect(maskText(text, masker).includes("0042")).toBe(false);
});
