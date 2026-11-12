import { open, type FileHandle } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { LOG_LIMITS } from "./limits.ts";

interface Entry {
  name: Buffer;
  size: number;
  crc: number;
  offset: number;
}

/** Store-only ZIP with data descriptors; at most 512 small central directory records in memory. */
export class LogZip {
  readonly #entries: Entry[] = [];
  #offset = 0;
  #busy = false;
  private constructor(readonly file: FileHandle) {}
  static async create(path: string) {
    return new LogZip(await open(path, "wx", 0o600));
  }
  get bytes() {
    return this.#offset;
  }

  async add(name: string, chunks: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    if (
      this.#busy ||
      this.#entries.length >= 512 ||
      !/^(?:Computer-[1-9]\d?\/)?(?:Worker-[1-9]\d?\/)?(?:desktop|gateway|worker|postgres|web|initdb)\.log$|^(?:Computer-[1-9]\d?\/)?manifest\.json$/.test(
        name,
      )
    )
      throw new Error("Invalid diagnostics ZIP entry");

    if (this.#entries.some((entry) => entry.name.toString() === name)) throw new Error("Duplicate ZIP entry");
    this.#busy = true;
    const entry = { name: Buffer.from(name), size: 0, crc: 0, offset: this.#offset };
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0808, 6);
    header.writeUInt16LE(entry.name.length, 26);
    let opened = false;

    try {
      await this.#write(header);
      await this.#write(entry.name);
      opened = true;

      for await (const data of chunks) {
        signal.throwIfAborted();

        if (data.byteLength > LOG_LIMITS.chunk) throw new Error("Oversized diagnostics ZIP chunk");
        await this.#write(data);
        entry.size += data.byteLength;
        entry.crc = crc32(data, entry.crc);
      }
    } finally {
      try {
        // A disconnected source still leaves a valid partial entry; manifest marks its truncation.
        if (opened) {
          const descriptor = Buffer.alloc(16);
          descriptor.writeUInt32LE(0x08074b50, 0);
          descriptor.writeUInt32LE(entry.crc, 4);
          descriptor.writeUInt32LE(entry.size, 8);
          descriptor.writeUInt32LE(entry.size, 12);
          await this.#write(descriptor);
          this.#entries.push(entry);
        }
      } finally {
        this.#busy = false;
      }
    }
  }

  async finish() {
    if (this.#busy) throw new Error("Diagnostics ZIP entry is still open");
    const start = this.#offset;

    for (const entry of this.#entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0808, 8);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.size, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt32LE(entry.offset, 42);
      await this.#write(header);
      await this.#write(entry.name);
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.#entries.length, 8);
    end.writeUInt16LE(this.#entries.length, 10);
    end.writeUInt32LE(this.#offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.#write(end);
    await this.file.sync();
  }

  async close() {
    await this.file.close();
  }

  async #write(bytes: Uint8Array) {
    // Reserve directory + manifest headroom inside the coordinator's 100 MiB disk budget.
    if (this.#offset + bytes.byteLength > LOG_LIMITS.zip) throw new Error("Diagnostics ZIP budget reached");
    let written = 0;

    while (written < bytes.byteLength) {
      const result = await this.file.write(bytes, written, bytes.byteLength - written, this.#offset);

      if (!result.bytesWritten) throw new Error("Diagnostics ZIP write failed");
      written += result.bytesWritten;
      this.#offset += result.bytesWritten;
    }
  }
}

type LogJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly LogJsonValue[]
  | { readonly [key: string]: LogJsonValue };

export async function* logJsonChunks(value: LogJsonValue) {
  const bytes = Buffer.from(JSON.stringify(value));

  if (bytes.length > 256 * 1024) throw new Error("Diagnostics manifest budget reached");

  for (let offset = 0; offset < bytes.length; offset += LOG_LIMITS.chunk)
    yield bytes.subarray(offset, offset + LOG_LIMITS.chunk);
}
