import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolCallSchema,
  ItemDeltaField,
  type AgentToolCall,
  type AgentToolResult,
  type ThreadEvent,
} from "@canopy/contracts";

interface ImportTurn {
  readonly items: Map<string, { candidate: boolean; tail: string; done: boolean }>;
  readonly controller: AbortController;
  pending?: Promise<void>;
  held: ThreadEvent[];
  ready?: boolean;
  flush?: () => void;
}

/** Hold the terminal journal boundary while copies commit, never another thread's text stream. */
export class MarkdownImageImports {
  readonly #turns = new Map<string, ImportTurn>();
  readonly #held = new Map<string, ImportTurn>();

  observe(event: ThreadEvent): string | undefined {
    const key = `${event.threadId}/${event.turnId}`;

    if (event.body.case === "turnStarted")
      this.#turns.set(key, {
        items: new Map(),
        controller: new AbortController(),
        held: [],
      });
    const turn = this.#turns.get(key);

    if (!turn) return;
    const body = event.body;

    if (body.case === "itemDelta" && body.value.field === ItemDeltaField.TEXT) {
      const tracked = turn.items.get(body.value.itemId);

      if (tracked) {
        tracked.candidate ||= (tracked.tail + body.value.chunk).includes("![");
        tracked.tail = body.value.chunk.slice(-1);
      }

      return;
    }

    if (body.case !== "itemStarted" && body.case !== "itemCompleted") return;
    const item = body.value.item;

    if (item?.content.case !== "agentMessage") return;

    if (turn.items.size >= 256 && !turn.items.has(item.itemId)) return;
    const tracked = turn.items.get(item.itemId) ?? { candidate: false, tail: "", done: false };
    tracked.candidate ||= item.content.value.text.includes("![");
    turn.items.set(item.itemId, tracked);

    if (body.case === "itemCompleted" && tracked.candidate && !tracked.done) {
      tracked.done = true;

      return item.itemId;
    }

    return undefined;
  }

  enqueue(
    event: ThreadEvent,
    itemId: string,
    call: (request: AgentToolCall, signal: AbortSignal) => Promise<AgentToolResult>,
  ) {
    const turn = this.#turns.get(`${event.threadId}/${event.turnId}`);

    if (!turn) return;
    turn.pending = (turn.pending ?? Promise.resolve())
      .then(async () => {
        if (turn.controller.signal.aborted) return;

        const hash = createHash("sha256")
          .update(JSON.stringify([event.threadId, event.turnId, itemId]))
          .digest("hex");

        const callId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        const timer = setTimeout(() => turn.controller.abort(), 65_000).unref();

        try {
          await call(
            create(AgentToolCallSchema, {
              callId,
              threadId: event.threadId,
              turnId: event.turnId,
              itemId,
              toolName: "import_image_reply",
              argumentsJson: JSON.stringify({ item_id: itemId }),
            }),
            turn.controller.signal,
          );
        } finally {
          clearTimeout(timer);
        }
      })
      .catch(() => {});
  }

  hold(event: ThreadEvent, send: (event: ThreadEvent) => void, connected: () => boolean): boolean {
    const key = `${event.threadId}/${event.turnId}`;
    const held = this.#held.get(event.threadId);

    if (held) {
      held.held.push(event);

      if (held.held.length >= 256) {
        held.controller.abort();
        held.ready = true;
        held.flush?.();
      }

      return true;
    }

    if (event.body.case !== "turnFinished") return false;
    const turn = this.#turns.get(key);

    if (!turn?.pending) {
      this.#turns.delete(key);

      return false;
    }

    turn.held.push(event);
    this.#held.set(event.threadId, turn);
    turn.flush = () => {
      if (!turn.ready || this.#held.get(event.threadId) !== turn) return;
      this.#held.delete(event.threadId);
      this.#turns.delete(key);

      for (const delayed of turn.held) send(delayed);
      turn.held = [];
    };

    void turn.pending.finally(() => {
      turn.ready = true;

      if (connected()) turn.flush?.();
    });

    return true;
  }

  canSend(event: ThreadEvent): boolean {
    const first = this.#held.get(event.threadId)?.held[0];

    return !first || event.journalSeq < first.journalSeq;
  }

  resume() {
    for (const turn of this.#held.values()) turn.flush?.();
  }

  close() {
    for (const turn of this.#turns.values()) turn.controller.abort();
  }
}
