import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { governBunSpawn } from "@canopy/process-governor";
import type { DesktopTarget } from "../agent-tools/desktop-window.ts";
import declarations from "./mac-window-capture-api.h.txt" with { type: "text" };
import program from "./mac-window-capture-child.js.txt" with { type: "text" };
import source from "./mac-window-capture.c.txt" with { type: "text" };
import { MAX_FRAME_BYTES } from "./types.ts";

interface MacWindowFrame {
  data: Uint8Array;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  title: string;
  windowAligned: boolean;
}

export interface MacWindowCapture {
  next(signal: AbortSignal): Promise<MacWindowFrame | undefined>;
  close(): Promise<void>;
}

function nativeTarget(target: DesktopTarget) {
  const { pid, process_instance } = target.identity;
  const id = /^w-([1-9]\d{0,9})$/.exec(target.identity.id);
  const generation = /^macos-proc-v1:([1-9]\d{0,10}):(0|[1-9]\d{0,5})$/.exec(process_instance);

  if (!id || Number(id[1]) > 0xffffffff || !generation || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff)
    return undefined;

  if (!target.app || target.app.length > 4096 || target.app.includes("\0")) return undefined;

  return {
    app: target.app,
    id: Number(id[1]),
    pid,
    seconds: generation[1],
    micros: generation[2],
    unique: target.unique,
  };
}

function launch(directory: string, target: NonNullable<ReturnType<typeof nativeTarget>>) {
  // TinyCC opens native paths. Keep the bundled source private until the child has loaded it.
  const path = join(directory, "capture.c");
  writeFileSync(path, source, { flag: "wx", mode: 0o600 });
  writeFileSync(join(directory, "capture-api.h"), declarations, { flag: "wx", mode: 0o600 });

  return governBunSpawn("supervisor", () =>
    Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--config=/dev/null",
        "-e",
        program,
        path,
        JSON.stringify(target),
        String(MAX_FRAME_BYTES),
      ],
      {
        cwd: directory,
        env: { BUN_BE_BUN: "1" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      },
    ),
  );
}

class WindowCapture implements MacWindowCapture {
  readonly #child: ReturnType<typeof launch>;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #lifetime: AbortSignal;
  readonly #released: Promise<void>;
  #buffer: Uint8Array = new Uint8Array();
  #closed = false;
  #pending: Promise<MacWindowFrame> | undefined;

  constructor(child: ReturnType<typeof launch>, signal: AbortSignal) {
    this.#child = child;
    this.#reader = child.stdout.getReader();
    this.#lifetime = signal;
    signal.addEventListener("abort", this.#stop, { once: true });
    this.#released = child.exited.then(async () => {
      this.#closed = true;
      this.#lifetime.removeEventListener("abort", this.#stop);
      this.#buffer = new Uint8Array();
      await Promise.allSettled([this.#reader.cancel(), Promise.resolve().then(() => child.stdin.end())]);
    });
  }

  #stop = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifetime.removeEventListener("abort", this.#stop);
    this.#child.kill("SIGKILL");
  };

  async close(): Promise<void> {
    this.#stop();
    await this.#released;
  }

  async #read(count: number): Promise<Buffer> {
    const result = Buffer.allocUnsafe(count);
    let offset = 0;

    while (offset < count) {
      if (!this.#buffer.length) {
        const chunk = await this.#reader.read();

        if (chunk.done) throw new Error("Desktop window capture ended");
        this.#buffer = chunk.value;
      }

      const length = Math.min(count - offset, this.#buffer.length);
      result.set(this.#buffer.subarray(0, length), offset);
      this.#buffer = this.#buffer.subarray(length);
      offset += length;
    }

    return result;
  }

  async #bounded<T>(signal: AbortSignal, timeout: number, read: () => Promise<T>): Promise<T | undefined> {
    if (signal.aborted || this.#lifetime.aborted) this.#stop();

    if (this.#closed) return undefined;
    const cancelRead = () => this.#stop();
    signal.addEventListener("abort", cancelRead, { once: true });
    const timer = setTimeout(this.#stop, timeout);

    try {
      const result = await read();

      return this.#closed ? undefined : result;
    } catch {
      await this.close();

      return undefined;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelRead);
    }
  }

  async ready(): Promise<boolean> {
    return Boolean(await this.#bounded(this.#lifetime, 3500, async () => (await this.#read(1))[0] === 1));
  }

  next(signal: AbortSignal): Promise<MacWindowFrame | undefined> {
    return this.#bounded(signal, 2000, () => {
      this.#pending ??= this.#frame().finally(() => {
        this.#pending = undefined;
      });

      return this.#pending;
    });
  }

  async #frame(): Promise<MacWindowFrame> {
    this.#child.stdin.write(Uint8Array.of(1));
    await this.#child.stdin.flush();
    const header = await this.#read(24);

    const size = header.readUInt32LE(0),
      titleSize = header.readUInt32LE(4);

    const width = header.readUInt32LE(8),
      height = header.readUInt32LE(12);

    const viewportWidth = header.readUInt32LE(16),
      viewportHeight = header.readUInt32LE(20);

    if (
      !size ||
      size > MAX_FRAME_BYTES ||
      titleSize > 16384 ||
      !width ||
      !height ||
      Math.max(width, height) > 1600 ||
      !viewportWidth ||
      !viewportHeight ||
      Math.max(viewportWidth, viewportHeight) > 8192
    )
      throw new Error("Invalid Desktop window frame");
    const title = (await this.#read(titleSize)).toString("utf8").slice(0, 4096);
    const data = await this.#read(size);

    if (data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(size - 2) !== 0xffd9)
      throw new Error("Invalid Desktop window image");

    return { data, width, height, viewportWidth, viewportHeight, title, windowAligned: true };
  }
}

export async function openMacWindowCapture(
  target: DesktopTarget,
  signal: AbortSignal,
): Promise<MacWindowCapture | undefined> {
  if (process.platform !== "darwin" || signal.aborted) return undefined;
  const selected = nativeTarget(target);

  if (!selected) return undefined;
  let directory: string | undefined;
  let capture: WindowCapture | undefined;

  try {
    directory = mkdtempSync(join(tmpdir(), "canopy-window-capture-"));
    capture = new WindowCapture(launch(directory, selected), signal);

    if (await capture.ready()) return capture;
  } catch {
    // The caller retains its existing exact-window capture when the native backend is unavailable.
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }

  await capture?.close();

  return undefined;
}
