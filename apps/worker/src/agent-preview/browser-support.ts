import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentPreviewInput } from "@canopy/contracts";
import type { JsonValue, PreviewRuntime } from "./runtime.ts";
import { MAX_IMAGE_BYTES } from "./types.ts";

const dimension = z.number().int().min(1).max(8192);

export const streamStatus = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535).nullable(),
  connected: z.boolean(),
});

export const messageType = z.object({ type: z.string() });

export const frameMessage = z.object({
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  data: z
    .string()
    .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  metadata: z.object({
    deviceWidth: dimension,
    deviceHeight: dimension,
    pageScaleFactor: z.number().finite().positive().max(100).default(1),
    offsetTop: z.number().finite().min(0).max(8192).default(0),
  }),
});

export const statusMessage = z.object({
  connected: z.boolean(),
  viewportWidth: dimension,
  viewportHeight: dimension,
  engine: z.string().optional(),
});

export const tabsMessage = z.object({
  tabs: z
    .array(
      z.object({
        tabId: z.string().max(128),
        title: z.string(),
        url: z.string(),
        active: z.boolean(),
      }),
    )
    .max(64),
});

export const urlMessage = z.object({ url: z.string() });
export const errorMessage = z.object({ message: z.string() });
export const MAX_STREAM_MESSAGE = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32 * 1024;

const viewportResult = z.object({ result: z.object({ width: dimension, height: dimension }) });

export class BrowserViewport {
  #key = "";
  #revision = 0;
  #size = { width: 0, height: 0 };

  invalidate(): void {
    this.#revision++;
  }

  async measure(
    runtime: PreviewRuntime,
    frame: z.infer<typeof frameMessage>,
    image: { width: number; height: number },
  ) {
    const { deviceWidth, deviceHeight, pageScaleFactor, offsetTop } = frame.metadata;

    const key = [this.#revision, deviceWidth, deviceHeight, pageScaleFactor, offsetTop, image.width, image.height].join(
      ":",
    );

    if (this.#key === key) return this.#size;

    // The pinned stream substitutes its configured window size for CDP's actual viewport dimensions.
    const measured = viewportResult.parse(
      await runtime.command(["eval", "({width:window.innerWidth,height:window.innerHeight})"]),
    );

    this.#size = measured.result;
    this.#key = key;

    return this.#size;
  }
}

export async function sendBrowserText(
  socket: Pick<WebSocket, "bufferedAmount" | "readyState">,
  value: string,
  signal: AbortSignal,
  send: (message: JsonValue) => void,
): Promise<void> {
  const deadline = Date.now() + 8_000;

  // Chrome's char event inserts one Unicode scalar; multi-character payloads are ignored.
  for (const text of value) {
    while (socket.bufferedAmount > 128 * 1024) {
      signal.throwIfAborted();

      if (socket.readyState !== WebSocket.OPEN) throw new Error("Browser stream is unavailable");

      if (Date.now() >= deadline) throw new Error("Browser text input timed out waiting for the stream");
      await delay(10, undefined, { signal });
    }

    signal.throwIfAborted();
    send({ type: "input_keyboard", eventType: "char", text });
  }
}

interface HeldInput {
  readonly keys: Map<string, AgentPreviewInput>;
  readonly buttons: Set<number>;
  x: number;
  y: number;
  click?: { button: number; x: number; y: number; at: number; count: number };
}

export interface BrowserLease {
  readonly port: number;
  readonly owned: boolean;
  readonly held: Map<string, HeldInput>;
  users: number;
}

const leases = new Map<string, BrowserLease>();
const changes = new Map<string, Promise<void>>();

async function changeSession<T>(session: string, run: () => Promise<T>): Promise<T> {
  const previous = changes.get(session) ?? Promise.resolve();
  const result = previous.then(run);

  const settled = result.then(
    () => undefined,
    () => undefined,
  );

  changes.set(session, settled);

  try {
    return await result;
  } finally {
    if (changes.get(session) === settled) changes.delete(session);
  }
}

export function acquireBrowserStream(runtime: PreviewRuntime): Promise<BrowserLease> {
  return changeSession(runtime.scope.session, async () => {
    const existing = leases.get(runtime.scope.session);

    if (existing) {
      existing.users++;

      return existing;
    }

    let status = streamStatus.parse(await runtime.command(["stream", "status"]));
    let owned = false;

    if (!status.enabled) {
      status = streamStatus.parse(await runtime.command(["stream", "enable", "--port", "0"]));
      owned = true;
    }

    if (!status.port) throw new Error("Browser stream did not report its port");
    const lease: BrowserLease = { port: status.port, owned, held: new Map(), users: 1 };
    leases.set(runtime.scope.session, lease);

    return lease;
  });
}

export function releaseBrowserStream(runtime: PreviewRuntime, lease: BrowserLease): Promise<void> {
  return changeSession(runtime.scope.session, async () => {
    if (leases.get(runtime.scope.session) !== lease || --lease.users > 0) return;

    try {
      if (!lease.owned) return;
      const status = streamStatus.parse(await runtime.command(["stream", "status"], { cleanup: true }));

      if (status.enabled && status.port === lease.port) await runtime.command(["stream", "disable"], { cleanup: true });
    } finally {
      leases.delete(runtime.scope.session);
    }
  });
}

export function heldInput(lease: BrowserLease, owner: string): HeldInput {
  let held = lease.held.get(owner);

  if (!held) {
    held = { keys: new Map(), buttons: new Set(), x: 0, y: 0 };
    lease.held.set(owner, held);
  }

  return held;
}

export function buttonHeldElsewhere(lease: BrowserLease, owner: string, button: number): boolean {
  for (const [other, held] of lease.held) {
    if (other !== owner && held.buttons.has(button)) return true;
  }

  return false;
}

export function keyHeldElsewhere(lease: BrowserLease, owner: string, key: string): boolean {
  for (const [other, held] of lease.held) {
    if (other !== owner && held.keys.has(key)) return true;
  }

  return false;
}

export function previewText(value: string, limit: number): string {
  const clean = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);

      return code >= 32 && !(code >= 127 && code <= 159);
    })
    .join("");

  const bytes = Buffer.from(clean);
  let end = Math.min(limit, bytes.length);

  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;

  return bytes.subarray(0, end).toString("utf8");
}

const keyCodes = new Map([
  ["Backspace", 8],
  ["Tab", 9],
  ["Enter", 13],
  ["Shift", 16],
  ["Control", 17],
  ["Alt", 18],
  ["Pause", 19],
  ["CapsLock", 20],
  ["Escape", 27],
  [" ", 32],
  ["PageUp", 33],
  ["PageDown", 34],
  ["End", 35],
  ["Home", 36],
  ["ArrowLeft", 37],
  ["ArrowUp", 38],
  ["ArrowRight", 39],
  ["ArrowDown", 40],
  ["Insert", 45],
  ["Delete", 46],
  ["Meta", 91],
]);

export function keyboardMessage(input: AgentPreviewInput, eventType: "keyDown" | "keyUp") {
  const key = input.key;
  const functionKey = /^F([1-9]|1\d|2[0-4])$/.exec(key);

  const code =
    keyCodes.get(key) ??
    (functionKey ? 111 + Number(functionKey[1]) : /^[A-Za-z0-9]$/.test(key) ? key.toUpperCase().charCodeAt(0) : 0);

  const text =
    eventType === "keyDown" && !(input.modifiers & 7)
      ? key === "Enter"
        ? "\r"
        : key === "Tab"
          ? "\t"
          : [...key].length === 1
            ? key
            : undefined
      : undefined;

  return {
    type: "input_keyboard",
    eventType,
    key,
    code: input.code,
    windowsVirtualKeyCode: code,
    modifiers: input.modifiers,
    ...(text !== undefined && { text }),
  };
}

export const mouseButton = (button: number): string => ["left", "middle", "right"][button] ?? "none";
