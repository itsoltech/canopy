import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { LOG_LIMITS, LOG_SOURCES, logSource } from "./limits.ts";
import { LogRedactor } from "./redaction.ts";

/** Six fixed sources × four 5 MiB files fit the 128 MiB home cap. No caller-supplied path. */
export class Logs extends LogRedactor {
  #prunedAt = 0;
  constructor(readonly directory: string) {
    super();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.prune();
  }
  prune(now = Date.now()) {
    this.#prunedAt = now;

    for (const source of LOG_SOURCES)
      for (let index = 0; index < LOG_LIMITS.files; index++) {
        const file = join(this.directory, `${source}.log${index ? `.${index}` : ""}`);

        if (!existsSync(file)) continue;
        const stat = lstatSync(file);

        if (stat.isSymbolicLink() || !stat.isFile() || stat.mtimeMs < now - LOG_LIMITS.retentionMs)
          rmSync(file, { force: true });
      }
  }
  write(name: string, line: string) {
    const source = logSource(name);

    if (!source) return;

    if (Date.now() - this.#prunedAt >= 3_600_000) this.prune();
    const text = `${new Date().toISOString()} ${this.redact(line)}\n`;

    if (Buffer.byteLength(text) > LOG_LIMITS.line || line.includes("\n")) return;
    const file = join(this.directory, `${source}.log`);

    if (existsSync(file)) {
      const stat = lstatSync(file);

      if (stat.isSymbolicLink() || !stat.isFile()) return;

      if (
        stat.size + Buffer.byteLength(text) > LOG_LIMITS.rotation ||
        stat.mtimeMs < Date.now() - LOG_LIMITS.retentionMs
      ) {
        rmSync(`${file}.3`, { force: true });

        for (let index = 2; index >= 0; index--) {
          const from = index ? `${file}.${index}` : file;

          if (existsSync(from)) renameSync(from, `${file}.${index + 1}`);
        }
      }
    }

    const descriptor = openSync(
      file,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );

    try {
      appendFileSync(descriptor, text);
    } finally {
      closeSync(descriptor);
    }
  }
  stream(name: string) {
    let pending = Buffer.alloc(0);
    let dropping = false;

    return (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;

      for (let index = 0; index <= bytes.length; index++) {
        if (index < bytes.length && bytes[index] !== 10) continue;
        const part = bytes.subarray(start, index);

        if (!dropping && pending.length + part.length <= LOG_LIMITS.line) pending = Buffer.concat([pending, part]);
        else {
          pending = Buffer.alloc(0);
          dropping = true;
        }

        if (index < bytes.length) {
          if (!dropping) this.write(name, pending.toString("utf8"));
          pending = Buffer.alloc(0);
          dropping = false;
        }

        start = index + 1;
      }
    };
  }
}
