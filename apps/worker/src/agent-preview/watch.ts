import type { MessageInitShape } from "@bufbuild/protobuf";
import type { AgentPreviewEventSchema } from "@canopy/contracts";
import { LEASE_MS, MAX_FRAME_BYTES, type PreviewUpdate } from "./types.ts";
import type { PreviewRuntime } from "./runtime.ts";

type Event = MessageInitShape<typeof AgentPreviewEventSchema>;

export function previewMetadata(update: PreviewUpdate): PreviewUpdate {
  const { data, ...metadata } = update;

  const targets = [...(metadata.targets ?? [])]
    .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)))
    .slice(0, 64);

  const bounded = { ...metadata, targets };

  while (targets.length && Buffer.byteLength(JSON.stringify(bounded)) > 32 * 1024) targets.pop();

  if (Buffer.byteLength(JSON.stringify(bounded)) > 32 * 1024) throw new Error("Preview metadata exceeds 32 KiB");

  for (const dimension of [update.width, update.height, update.viewportWidth, update.viewportHeight]) {
    if (dimension !== undefined && (!Number.isInteger(dimension) || dimension < 0 || dimension > 8192))
      throw new Error("Preview dimensions exceed their limit");
  }

  if (data && data.byteLength > MAX_FRAME_BYTES) throw new Error("Preview frame exceeds 2 MiB");

  return { ...bounded, ...(data && { data }) };
}

export class PreviewWatch {
  readonly id: string;
  readonly threadId: string;
  readonly #send: (event: Event) => void | Promise<void>;
  readonly #stop: () => void;
  readonly #capacityChanged: (() => void) | undefined;
  readonly #interval: number;
  readonly #leaseMs: number;
  #lease: Timer | undefined;
  #timer: Timer | undefined;
  #latest: PreviewUpdate | undefined;
  #currentCursor: PreviewRuntime["desktopCursor"] | undefined;
  #stillCurrent: (() => boolean) | undefined;
  #sent = 0n;
  #outstanding = 0n;
  #next = 0;
  #sending = false;
  #closed = false;

  constructor(options: {
    id: string;
    threadId: string;
    maxFps: number;
    send: (event: Event) => void | Promise<void>;
    stop: () => void;
    capacityChanged?: () => void;
    leaseMs?: number;
  }) {
    this.id = options.id;
    this.threadId = options.threadId;
    this.#send = options.send;
    this.#stop = options.stop;
    this.#capacityChanged = options.capacityChanged;
    this.#interval = 1000 / Math.max(1, Math.min(12, options.maxFps || 6));
    this.#leaseMs = options.leaseMs ?? LEASE_MS;
    this.#renew();
  }

  get capacity(): boolean {
    return this.nextFrameIn === 0;
  }

  get nextFrameIn(): number {
    return this.#closed || this.#outstanding || this.#sending ? Infinity : Math.max(0, this.#next - Date.now());
  }

  ack(frameId: bigint): void {
    if (this.#closed || frameId < 0n || frameId > this.#sent) return;
    this.#renew();

    if (frameId && frameId === this.#outstanding) {
      this.#outstanding = 0n;
      this.#flush();
      this.#capacityChanged?.();
    }
  }

  offer(update: PreviewUpdate, currentCursor?: PreviewRuntime["desktopCursor"], stillCurrent?: () => boolean): void {
    if (this.#closed) return;

    if (update.state === "frame") {
      // A passive watcher always receives a freshly verified capture after its previous ACK.
      if (update.followingAgent && (!this.capacity || !stillCurrent?.() || this.#latest?.agentObservation)) return;

      if (update.agentObservation && !stillCurrent?.()) return;
      this.#latest = update;
      this.#currentCursor = currentCursor;
      this.#stillCurrent = stillCurrent;
      this.#flush();
    } else {
      if (
        update.state === "error" ||
        (this.#latest?.agentObservation && !update.targetId) ||
        (update.targetId !== undefined && update.targetId !== this.#latest?.targetId)
      ) {
        this.#latest = undefined;
        this.#stillCurrent = undefined;
      }

      this.#deliver({ ...update, previewId: this.id });
    }
  }

  #renew(): void {
    clearTimeout(this.#lease);
    this.#lease = setTimeout(this.#stop, this.#leaseMs);
    this.#lease.unref();
  }

  #flush(): void {
    if (this.#closed || !this.#latest || this.#outstanding || this.#sending) return;

    if (Date.now() < this.#next) {
      this.#timer ??= setTimeout(() => {
        this.#timer = undefined;
        this.#flush();
      }, this.#next - Date.now());

      return;
    }

    const update = this.#latest;
    const stillCurrent = this.#stillCurrent;
    this.#latest = undefined;
    this.#stillCurrent = undefined;
    this.#outstanding = ++this.#sent;
    this.#next = Date.now() + this.#interval;
    this.#sending = true;
    this.#deliver({ ...update, previewId: this.id, frameId: this.#sent }, true, stillCurrent);
  }

  #deliver(event: Event, frame = false, stillCurrent?: () => boolean): void {
    const delivered = Promise.resolve().then(() => {
      if (frame && (this.#closed || (stillCurrent && !stillCurrent()))) {
        this.#outstanding = 0n;
        this.#next = 0;

        return;
      }

      if (event.cursor) {
        const current = this.#currentCursor?.();

        if (!frame || !current || current.actionId !== event.cursor.actionId) delete event.cursor;
        else if (!current.click && event.cursor.click) event.cursor = { ...event.cursor, click: false };
      }

      return this.#send(event);
    });

    void delivered.then(
      () => {
        if (frame) {
          this.#sending = false;
          this.#flush();
          this.#capacityChanged?.();
        }
      },
      () => this.#stop(),
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#lease);
    clearTimeout(this.#timer);
    this.#latest = undefined;
    this.#stillCurrent = undefined;
    this.#deliver({ previewId: this.id, state: "closed" });
  }
}
