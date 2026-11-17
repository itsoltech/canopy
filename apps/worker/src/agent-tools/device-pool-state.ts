import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const deviceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  platform: z.string(),
  kind: z.enum(["emulator", "simulator", "device"]),
  booted: z.boolean(),
  busy: z.boolean().optional(),
});

const ownershipSchema = z.array(
  z.object({ key: z.string(), session: z.string(), stop: z.boolean(), device: deviceSchema }),
);

export type Ownership = z.infer<typeof ownershipSchema>[number];

/** Synchronous atomic journal updates never hold an asynchronous device admission lane. */
export class DeviceOwnership {
  readonly entries = new Map<string, Ownership>();
  readonly #path: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.#path = join(dataDir, "device-pool.json");

    if (existsSync(this.#path)) {
      for (const entry of ownershipSchema.parse(JSON.parse(readFileSync(this.#path, "utf8")))) {
        if (entry.stop && entry.device.kind === "device") throw new Error("Invalid physical device ownership");
        this.entries.set(entry.key, entry);
      }
    }
  }

  save(): void {
    const temporary = `${this.#path}.tmp`;
    const fd = openSync(temporary, "w", 0o600);

    try {
      writeFileSync(fd, JSON.stringify([...this.entries.values()]));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(temporary, this.#path);
  }
}

export function matchesPlatform(device: string, selector?: string): boolean {
  return !selector || device === selector || (selector === "apple" && (device === "ios" || device === "macos"));
}

export function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };

    signal.addEventListener("abort", abort, { once: true });

    if (signal.aborted) abort();
    void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class DeviceWakeup {
  readonly #waiting = new Set<() => void>();
  version = 0;

  notify(): void {
    this.version++;

    for (const finish of this.#waiting) finish();
  }

  wait(signal: AbortSignal, version: number): Promise<void> {
    if (version !== this.version) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        cleanup();
        resolve();
      };

      const abort = () => {
        cleanup();
        reject(signal.reason);
      };

      const timer = setTimeout(finish, 1_000);

      const cleanup = () => {
        clearTimeout(timer);
        this.#waiting.delete(finish);
        signal.removeEventListener("abort", abort);
      };

      this.#waiting.add(finish);
      signal.addEventListener("abort", abort, { once: true });

      if (signal.aborted) abort();
    });
  }
}

/** Native startup was never attempted; the durable reservation may be discarded without shutdown. */
export class DeviceBootNotStartedError extends Error {}
