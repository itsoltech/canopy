import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/** Line buffering prevents a secret split across stdout chunks from reaching disk. */
export class Logs {
  private readonly secrets = new Set<string>();
  constructor(readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  protect(...values: string[]) { for (const value of values) if (value.length >= 8) this.secrets.add(value); }
  redact(line: string) {
    for (const value of this.secrets) line = line.replaceAll(value, "[REDACTED]");
    return line
      .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
      .replace(/((?:credential|password|api[_-]?key|enrollment[_-]?token|service[_-]?token|secrets[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]")
      .replace(/(postgres(?:ql)?:\/\/[^: /]+:)[^@\s]+@/gi, "$1[REDACTED]@");
  }
  write(name: string, line: string) {
    const file = join(this.directory, `${name}.log`);
    if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) {
      for (let i = 2; i >= 0; i--) {
        const from = i === 0 ? file : `${file}.${i}`;
        if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
      }
    }
    appendFileSync(file, `${new Date().toISOString()} ${this.redact(line)}\n`, { mode: 0o600 });
  }
  stream(name: string) {
    let pending = "";
    let dropping = false;
    return (chunk: Buffer | string) => {
      pending += chunk.toString();
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        if (!dropping && line.length <= 16_384) this.write(name, line);
        pending = pending.slice(end + 1);
        dropping = false;
      }
      if (pending.length > 16_384) { pending = ""; dropping = true; }
    };
  }
}
