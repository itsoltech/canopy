import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ThreadDiffLineKind as Kind,
  ThreadDiffLineSchema,
  type ThreadDiffFile,
  type ThreadDiffLine,
} from "@canopy/contracts";
import { diffBytes, DiffLimit, type DiffBudget } from "./diff-process.ts";
import { StringDecoder } from "node:string_decoder";
import { DIFF_LINE_BYTES, DIFF_PAGE_CONTENT_BYTES } from "@canopy/domain/thread-diff-limits";

export interface DiffSpool {
  filename: string;
  offsets: number[];
  file: ThreadDiffFile;
}

/** Sparse offsets every 128 records keep both creation and random access bounded. */
export class DiffSpoolWriter {
  readonly offsets: number[] = [];
  readonly #fd: number;
  readonly #decoder = new StringDecoder("utf8");
  #pending = "";
  #oldLine = 0;
  #newLine = 0;
  #hunk = false;
  #position = 0;
  #buffered = 0;
  #chunks: Buffer[] = [];

  constructor(
    readonly filename: string,
    readonly file: ThreadDiffFile,
    readonly budget: DiffBudget,
  ) {
    this.#fd = openSync(filename, "wx", 0o600);
  }

  append(line: ThreadDiffLine) {
    const encoded = toBinary(ThreadDiffLineSchema, line);

    if (encoded.byteLength > DIFF_LINE_BYTES) throw new DiffLimit();
    const length = Buffer.alloc(4);
    length.writeUInt32LE(encoded.byteLength);
    diffBytes(this.budget, encoded.byteLength + 4);

    if (this.file.lineCount % 128 === 0) this.offsets.push(this.#position);
    this.#position += encoded.byteLength + 4;
    this.file.lineCount++;
    this.#chunks.push(length, Buffer.from(encoded));
    this.#buffered += encoded.byteLength + 4;

    if (this.#buffered >= 64 * 1024) this.#flush();
  }

  consume(chunk: Buffer) {
    this.#pending += this.#decoder.write(chunk);
    let start = 0;
    let end: number;

    while ((end = this.#pending.indexOf("\n", start)) >= 0) {
      this.#parse(this.#pending.slice(start, end));
      start = end + 1;
    }

    this.#pending = this.#pending.slice(start);

    if (Buffer.byteLength(this.#pending) > DIFF_LINE_BYTES) throw new DiffLimit();
  }

  #parse(text: string) {
    if (Buffer.byteLength(text) > DIFF_LINE_BYTES) throw new DiffLimit();
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);

    if (hunk) {
      this.#oldLine = Number(hunk[1]);
      this.#newLine = Number(hunk[2]);
      this.#hunk = true;
      this.append(create(ThreadDiffLineSchema, { kind: Kind.HUNK, text }));

      return;
    }

    if (text.startsWith("Binary files ")) this.file.binary = true;

    if (this.#hunk && [" ", "+", "-"].includes(text[0] ?? "")) {
      const addition = text.startsWith("+");
      const deletion = text.startsWith("-");
      this.file.additions += Number(addition);
      this.file.deletions += Number(deletion);
      this.append(
        create(ThreadDiffLineSchema, {
          kind: addition ? Kind.ADDITION : deletion ? Kind.DELETION : Kind.CONTEXT,
          text: text.slice(1),
          ...(!addition && { oldLine: this.#oldLine++ }),
          ...(!deletion && { newLine: this.#newLine++ }),
        }),
      );
    } else if (this.#hunk || text.startsWith("Binary files ")) {
      // Omit temporary paths and generated patch headers from the UI and transport.
      this.append(
        create(ThreadDiffLineSchema, {
          kind: Kind.META,
          text: this.file.binary ? "Binary file changed" : text,
        }),
      );
    }
  }

  finish() {
    this.#pending += this.#decoder.end();

    if (this.#pending) this.#parse(this.#pending);

    if (!this.file.lineCount) this.append(create(ThreadDiffLineSchema, { kind: Kind.META, text: "File changed" }));
    this.#flush();

    return { filename: this.filename, file: this.file, offsets: this.offsets };
  }

  #flush() {
    if (this.#chunks.length) writeFileSync(this.#fd, Buffer.concat(this.#chunks));
    this.#chunks = [];
    this.#buffered = 0;
  }

  close() {
    closeSync(this.#fd);
  }
}

export function readDiffSpool(spool: DiffSpool, offset: number, limit: number): ThreadDiffLine[] {
  const fd = openSync(spool.filename, "r");
  const result: ThreadDiffLine[] = [];
  const block = Math.floor(offset / 128);
  let position = spool.offsets[block];
  let bytes = 0;

  try {
    if (position === undefined) return result;
    const header = Buffer.alloc(4);

    for (let index = block * 128; index < Math.min(spool.file.lineCount, offset + limit); index++) {
      if (readSync(fd, header, 0, 4, position) !== 4) throw new Error("Changes unavailable");
      const size = header.readUInt32LE();
      position += 4;

      if (index >= offset) {
        if (bytes + size > DIFF_PAGE_CONTENT_BYTES && result.length) break;
        const data = Buffer.alloc(size);

        if (readSync(fd, data, 0, size, position) !== size) throw new Error("Changes unavailable");
        result.push(fromBinary(ThreadDiffLineSchema, data));
        bytes += size;
      }

      position += size;
    }

    return result;
  } finally {
    closeSync(fd);
  }
}
