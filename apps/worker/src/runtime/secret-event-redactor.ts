import { ItemDeltaField } from "@canopy/contracts";
import { Match, Predicate } from "effect";
import type { ThreadEventInit } from "../journal/journal.ts";
import {
  projectSecretJournalValues,
  redactSecretText,
  retainsProjectSecretOutput,
  secretPatterns,
} from "./project-secret-guard.ts";
import { threadBrowserValues, threadSecretRedactionValues } from "./thread-secrets.ts";
import { hideProjectSecretCall } from "./project-secret-tool.ts";

type Redactable =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Uint8Array
  | readonly Redactable[]
  | { readonly [key: string]: Redactable };

interface OutputBuffer {
  readonly chunks: Map<number, string>;
  readonly legacyValues: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

const IDENTIFIER_FIELDS = new Set([
  "$typeName",
  "case",
  "itemId",
  "taskId",
  "processId",
  "providerRunId",
  "sourceItemId",
  "parentTaskId",
  "startedInTurnId",
  "turnId",
  "providerTurnRef",
  "callId",
  "requestId",
  "inputId",
  "threadId",
  "connectorAccountId",
  "status",
]);

const OUTPUT_TOO_LARGE = "[Output withheld: too large to redact]";

function mask(value: Redactable, text: (value: string, field: string) => string, field = ""): Redactable {
  if (Predicate.isString(value)) return text(value, field);

  if (Array.isArray(value)) return value.map((entry) => mask(entry, text, field));

  if (value && Predicate.isObject(value) && !(value instanceof Uint8Array))
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mask(entry, text, key)]));

  return value;
}

function withholdSettledProjectOutput(event: ThreadEventInit): ThreadEventInit {
  const body = event.body;

  if (body?.case === "itemDelta")
    return { ...event, rawJson: "", body: { ...body, value: { ...body.value, chunk: "" } } };

  if (body?.case === "notice")
    return { ...event, rawJson: "", body: { ...body, value: { ...body.value, message: "[REDACTED]" } } };

  if (body?.case !== "itemStarted" && body?.case !== "itemCompleted" && body?.case !== "shellInputPrepared")
    return { ...event, rawJson: "" };

  const withheld = mask(body, (text, field) => (!text || IDENTIFIER_FIELDS.has(field) ? text : "[REDACTED]"));

  // SAFETY: mask preserves the shape of the protobuf fields and the oneof discriminator.
  return { ...event, rawJson: "", body: withheld as typeof body };
}

/** Before durable events are written. Deltas are withheld while a secret is live: a value
 * split across chunks cannot be safely masked one chunk at a time. Completed items carry full output. */
export function secretEventRedactor(
  protectedTurn: (threadId: string, turnId: string) => boolean,
  backgroundTurn: (threadId: string, itemId: string) => string | undefined,
): (threadId: string, event: ThreadEventInit) => ThreadEventInit {
  const buffers = new Map<string, OutputBuffer>();

  const dropBuffer = (key: string) => {
    const timer = buffers.get(key)?.timer;

    if (timer) clearTimeout(timer);
    buffers.delete(key);
  };

  return (threadId, event) => {
    event = hideProjectSecretCall(event);
    const body = event.body;

    if (body?.case === "turnFinished")
      for (const id of buffers.keys()) if (id.startsWith(`${threadId}/`)) dropBuffer(id);

    const itemId = Match.value(body).pipe(
      Match.when({ case: "itemDelta" }, (delta) => delta.value.itemId),
      Match.when({ case: "itemStarted" }, (started) => started.value.item?.itemId),
      Match.when({ case: "itemCompleted" }, (completed) => completed.value.item?.itemId),
      Match.orElse(() => undefined),
    );

    const key = `${threadId}/${itemId}`;
    const buffered = buffers.get(key);
    const item = body?.case === "itemStarted" || body?.case === "itemCompleted" ? body.value.item : undefined;
    const origin = item?.content?.case === "backgroundTask" ? item.content.value.startedInTurnId : undefined;
    const turnId = origin || (itemId ? backgroundTurn(threadId, itemId) : undefined) || event.turnId;

    if (turnId && !retainsProjectSecretOutput(threadId, turnId) && protectedTurn(threadId, turnId)) {
      dropBuffer(key);

      return withholdSettledProjectOutput(event);
    }

    const legacy = [...threadSecretRedactionValues(), ...threadBrowserValues(threadId)];
    const project = [...projectSecretJournalValues(threadId)];
    const patterns = secretPatterns([...legacy, ...project, ...(buffered?.legacyValues ?? [])]);

    if (buffered?.timer && !project.length) {
      dropBuffer(key);

      return withholdSettledProjectOutput(event);
    }

    if (!patterns.length && !buffered) return event;

    if (body?.case === "itemDelta" && (!project.length || turnId)) {
      const buffer: OutputBuffer = buffered ?? { chunks: new Map(), legacyValues: new Set() };
      const field = body.value.field ?? 0;
      const previous = buffer.chunks.get(field) ?? "";
      const chunk = body.value.chunk ?? "";
      buffer.chunks.set(
        field,
        previous !== OUTPUT_TOO_LARGE && previous.length + chunk.length <= 4 * 1024 * 1024
          ? previous + chunk
          : OUTPUT_TOO_LARGE,
      );

      for (const value of legacy) buffer.legacyValues.add(value);

      // Late background streams may have no new turn_finished or final item.
      if (project.length) {
        if (buffer.timer) clearTimeout(buffer.timer);
        buffer.timer = setTimeout(() => dropBuffer(key), 30_000).unref();
      }

      buffers.set(key, buffer);
    }

    if (body?.case === "itemCompleted" && buffered) {
      event = structuredClone(event);
      const item = event.body?.case === "itemCompleted" ? event.body.value.item : undefined;
      const content = item?.content;

      if (content?.case === "agentMessage" || content?.case === "reasoning") {
        if (!content.value.text) content.value.text = buffered.chunks.get(ItemDeltaField.TEXT) ?? "";
      }

      if (content?.case === "reasoning" && !content.value.summary)
        content.value.summary = buffered.chunks.get(ItemDeltaField.SUMMARY) ?? "";

      if (content?.case === "commandExecution" || content?.case === "toolCall" || content?.case === "backgroundTask") {
        if (!content.value.output) content.value.output = buffered.chunks.get(ItemDeltaField.OUTPUT) ?? "";
      }

      dropBuffer(key);
    }

    // SAFETY: mask preserves every key, array position, byte array, bigint and scalar type;
    // only string contents change, so the event retains its protobuf initialization contract.
    const safe = mask({ ...event, rawJson: "" }, (text, field) =>
      IDENTIFIER_FIELDS.has(field) ? text : redactSecretText(text, patterns),
    ) as ThreadEventInit;

    if (safe.body?.case === "itemDelta") safe.body.value.chunk = "";

    return safe;
  };
}
