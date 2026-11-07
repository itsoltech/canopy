import { createHash } from "node:crypto";
import { create, ScalarType, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { isReflectMessage, reflect, type ReflectMessage } from "@bufbuild/protobuf/reflect";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import {
  ImportedTurnSchema,
  ItemSchema,
  ItemStatus,
  ThreadEventSchema,
  TurnEndSource,
  TurnOutcome,
  type ImportedTurn,
  type Item,
  type ThreadEvent,
} from "@canopy/contracts";
import { HIDDEN, maskText, spanningSecrets, type Masker } from "./masking.ts";

/**
 * Turns of an imported thread (docs/import.md, "Strony"): items in timeline order, each sent once with its final
 * state (`item_completed`). Ids derive from the Canopy thread and the source's own ids (UUIDv5), so a page read
 * twice yields the same turns and events and the gateway stores them once. Text is masked and capped here, before
 * anything leaves the worker: every string field as decoded text (JSON inside a field, such as tool arguments, is
 * decoded and masked value by value), and every field, item and turn within the bounds below, so a page always
 * fits the worker link.
 */

type ItemInit = MessageInitShape<typeof ItemSchema>;

type Content = NonNullable<ItemInit["content"]>;

/** One text field of an imported item; readers shorten longer text with a note. */
export const MAX_FIELD = 1024 ** 2;

/**
 * Size bounds, measured on the protobuf encoding the link carries (events with their envelopes): an item event is
 * at most MAX_EVENT (its fields shrink to 16 KiB, then 1 KiB, and a step still larger keeps its place with a note),
 * a turn at most MAX_TURN (later steps are left out with a note), so a page of at most 4 MiB plus one turn stays far
 * below the link's 32 MiB.
 */
export const MAX_EVENT = 1536 * 1024;
export const MAX_TURN = 8 * 1024 ** 2;
const SHRINK = [16 * 1024, 1024] as const;

/** Model names, provider refs and other turn metadata. */
const METADATA = 1024;

/** Room for the turn's own start and end events and the note about left-out steps. */
const TURN_RESERVE = 64 * 1024;

export function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");

  const hash = createHash("sha1")
    .update(Buffer.concat([ns, Buffer.from(name)]))
    .digest();

  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Text cut to `limit` with a note. Only for text that is masked already (see maskedText). */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;

  return `${text.slice(0, limit)}\n[… ${Math.round((text.length - limit) / 1024)} KB shortened on import]`;
}

/**
 * The one way imported text is bounded: the complete text is masked first (JSON inside it decoded whole), then cut.
 * Cutting first could break JSON around an escaped secret, so readers pass text as it is and never cut it.
 */
export function maskedText(text: string, masker: Masker, limit = MAX_FIELD): string {
  return cut(maskText(text, masker), limit);
}

export interface TurnDraft {
  /** The source's id of the turn's first entry (stable per source). */
  readonly ref: string;
  prompt: string;
  startedMs?: number;
  endedMs?: number;
  status: "completed" | "interrupted" | "failed";
  error: string;
  providerTurnRef: string;
  model: string;
  readonly items: Map<string, { item: ItemInit; at: number | undefined }>;
}

export function draft(ref: string, prompt: string, at: number | undefined): TurnDraft {
  return {
    ref,
    prompt,
    ...(at !== undefined && { startedMs: at }),
    status: "completed",
    error: "",
    providerTurnRef: "",
    model: "",
    items: new Map(),
  };
}

export function setItem(
  turn: TurnDraft,
  itemId: string,
  content: Content,
  status: ItemStatus,
  at: number | undefined,
  parentItemId = "",
): void {
  const previous = turn.items.get(itemId);
  turn.items.set(itemId, {
    item: { itemId, status, content, ...(parentItemId && { parentItemId }) },
    at: previous?.at ?? at,
  });

  if (at !== undefined) turn.endedMs = Math.max(turn.endedMs ?? at, at);
}

/** The final turn: unfinished items end as interrupted, ids are derived, text is masked and bounded. */
export function finish(threadId: string, sourceId: string, turn: TurnDraft, masker: Masker): ImportedTurn {
  const turnId = uuidV5(threadId, `turn:${sourceId}:${turn.ref}`);
  const steps = joinedMasked(turn, masker);
  const prompt = steps.prompt;
  // The note's id is bounded whatever the source's turn id is (its digest).
  const noteId = `left:${createHash("sha1").update(turn.ref).digest("hex").slice(0, 16)}`;
  // Metadata is masked and bounded like any field (a model name or a ref is short; a longer one is cut).
  const model = maskedText(turn.model, masker, METADATA);
  const providerTurnRef = maskedText(turn.providerTurnRef, masker, METADATA);
  const error = maskedText(turn.error, masker, 4000);
  const budget = MAX_TURN - TURN_RESERVE - Buffer.byteLength(prompt);
  const events: ThreadEvent[] = [];
  let bytes = 0;
  let left = 0;

  const event = (item: Item, at: number | undefined) => {
    const occurredMs = at ?? turn.startedMs;

    return create(ThreadEventSchema, {
      threadId,
      // The item's encoded content is part of the id: a turn read again adds every step that changed since.
      eventId: uuidV5(threadId, `item:${sourceId}:${item.itemId}:${revision(item)}`),
      turnId,
      ...(occurredMs !== undefined && { occurredAt: timestampFromMs(occurredMs) }),
      body: { case: "itemCompleted", value: { item } },
    });
  };

  for (const { item, at } of steps.items) {
    if (left > 0) {
      left += 1;
      continue;
    }

    const bounded = boundedEvent(item, masker, (i) => event(i, at));
    const size = framed(toBinary(ThreadEventSchema, bounded).length);

    if (bytes + size > budget) {
      left = 1;
      continue;
    }

    bytes += size;
    events.push(bounded);
  }

  if (left > 0) {
    const note = `${left} more ${left === 1 ? "step" : "steps"} of this turn not imported: the turn is too large.`;
    events.push(
      event(
        create(ItemSchema, {
          itemId: noteId,
          status: ItemStatus.COMPLETED,
          content: { case: "agentMessage", value: { text: note } },
        }),
        turn.endedMs,
      ),
    );
  }

  const endedMs = turn.endedMs ?? turn.startedMs;
  const stamp = (ms: number | undefined) => (ms === undefined ? {} : { occurredAt: timestampFromMs(ms) });

  // The turn's own start and end, as in a live timeline (a turn is never empty).
  const started = create(ThreadEventSchema, {
    threadId,
    eventId: uuidV5(threadId, `started:${sourceId}:${turn.ref}`),
    turnId,
    ...stamp(turn.startedMs),
    body: { case: "turnStarted", value: { providerTurnRef, model } },
  });

  const ended = create(ThreadEventSchema, {
    threadId,
    eventId: uuidV5(threadId, `finished:${sourceId}:${turn.ref}`),
    turnId,
    ...stamp(endedMs),
    body: {
      case: "turnFinished",
      value: {
        outcome: OUTCOMES[turn.status],
        providerTurnRef,
        reason: error,
        source: SOURCES[turn.status],
      },
    },
  });

  const whole = create(ImportedTurnSchema, {
    turnId,
    prompt,
    ...(turn.startedMs !== undefined && { startedAt: timestampFromMs(turn.startedMs) }),
    ...((turn.endedMs ?? turn.startedMs) !== undefined && {
      completedAt: timestampFromMs(turn.endedMs ?? turn.startedMs ?? 0),
    }),
    status: turn.status,
    error,
    providerTurnRef,
    events: [started, ...events, ended],
    model,
  });

  // The budget above makes this hold; a turn that would not fit is never sent: its steps give way to a note.
  if (toBinary(ImportedTurnSchema, whole).length <= MAX_TURN) return whole;

  const note = event(
    create(ItemSchema, {
      itemId: noteId,
      status: ItemStatus.COMPLETED,
      content: { case: "agentMessage", value: { text: "This turn is too large to import." } },
    }),
    turn.endedMs,
  );

  const fallback = create(ImportedTurnSchema, {
    ...whole,
    prompt: cut(prompt, 16 * 1024),
    error: cut(error, 1024),
    events: [started, note, ended],
  });

  // Every part of the fallback is bounded (no source id of any length in it); checked all the same.
  if (toBinary(ImportedTurnSchema, fallback).length > MAX_TURN) throw new Error("an imported turn exceeds its bound");

  return fallback;
}

/**
 * The turn's prompt (masked) and its items as messages, with every string a secret spans across fields hidden.
 * Readers put text into items as the CLI wrote it (a message streamed in chunks or written as several blocks): the
 * prompt and the items' fields, joined by lines in order, are checked first, so a key whose header is in one field
 * and its body in the next cannot be read back from the parts. Each field is masked on its own after that.
 */
function joinedMasked(turn: TurnDraft, masker: Masker) {
  const items = [...turn.items.values()].map(({ item, at }) => ({
    item: create(
      ItemSchema,
      item.status === ItemStatus.IN_PROGRESS ? { ...item, status: ItemStatus.INTERRUPTED } : item,
    ),
    at,
  }));

  const fields = [turn.prompt];

  for (const { item } of items) rewriteStrings(reflect(ItemSchema, item), (text) => (fields.push(text), text));
  const hidden = spanningSecrets(fields, masker);
  let field = 1;

  if (hidden.size > 0)
    for (const { item } of items)
      rewriteStrings(reflect(ItemSchema, item), (text) => (hidden.has(field++) ? HIDDEN : text));

  return { prompt: hidden.has(0) ? HIDDEN : maskedText(turn.prompt, masker), items };
}

/**
 * The item masked, as an event within MAX_EVENT: fields shrink step by step; a step still too large (a very long
 * list) keeps its id, status and place with a note instead of its content.
 */
function boundedEvent(item: Item, masker: Masker, event: (item: Item) => ThreadEvent): ThreadEvent {
  rewriteStrings(reflect(ItemSchema, item), (text) => maskedText(text, masker));
  let current = event(item);

  for (const limit of SHRINK) {
    if (toBinary(ThreadEventSchema, current).length <= MAX_EVENT) return current;
    rewriteStrings(reflect(ItemSchema, item), (text) => cut(text, limit));
    current = event(item);
  }

  const size = toBinary(ThreadEventSchema, current).length;

  if (size <= MAX_EVENT) return current;

  return event(
    create(ItemSchema, {
      itemId: item.itemId,
      parentItemId: item.parentItemId,
      status: item.status,
      content: {
        case: "agentMessage",
        value: { text: `This step is too large to import (${Math.round(size / 1024)} KB).` },
      },
    }),
  );
}

/** Bytes an encoded message takes as an element of a repeated field: its tag, its length and itself. */
function framed(size: number): number {
  let prefix = 1;

  for (let rest = size; rest >= 128; rest >>= 7) prefix += 1;

  return 1 + prefix + size;
}

/** A short digest of the item's encoding: a new revision of a step gets a new event id. */
function revision(item: Item): string {
  return createHash("sha1").update(toBinary(ItemSchema, item)).digest("hex").slice(0, 16);
}

/** Every string field of a message and of its nested messages, lists and maps, rewritten in place. */
function rewriteStrings(message: ReflectMessage, rewrite: (text: string) => string): void {
  for (const field of message.fields) {
    if (!message.isSet(field)) continue;

    switch (field.fieldKind) {
      case "scalar":
        if (field.scalar === ScalarType.STRING) message.set(field, rewrite(String(message.get(field))));
        break;
      case "message":
        rewriteStrings(message.get(field), rewrite);
        break;
      case "list": {
        const list = message.get(field);

        for (let i = 0; i < list.size; i++) {
          const value = list.get(i);

          if (isReflectMessage(value)) rewriteStrings(value, rewrite);
          else if (field.listKind === "scalar" && field.scalar === ScalarType.STRING)
            list.set(i, rewrite(String(list.get(i))));
        }

        break;
      }

      case "map": {
        const map = message.get(field);

        for (const [key, value] of map) {
          if (isReflectMessage(value)) rewriteStrings(value, rewrite);
          else if (field.mapKind === "scalar" && field.scalar === ScalarType.STRING)
            map.set(key, rewrite(String(value)));
        }

        break;
      }

      default:
        break;
    }
  }
}

const SOURCES = {
  completed: TurnEndSource.UNSPECIFIED,
  interrupted: TurnEndSource.USER,
  failed: TurnEndSource.HARNESS,
} as const;

const OUTCOMES = {
  completed: TurnOutcome.COMPLETED,
  interrupted: TurnOutcome.INTERRUPTED,
  failed: TurnOutcome.FAILED,
} as const;

/** Encoded size of a turn, for the page budget. */
export function turnBytes(turn: ImportedTurn): number {
  return toBinary(ImportedTurnSchema, turn).length;
}
