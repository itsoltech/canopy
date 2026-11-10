import { create } from "@bufbuild/protobuf";
import { CloneProgressSchema, type CloneProgress } from "@canopy/contracts";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

const INTERVAL_MS = 250;
const MAX_LINES = 30;
const MAX_LINE = 500;
const MAX_PENDING = 8192;

/** Diagnostics are untrusted, including output from credential helpers and remote hooks. */
export function sanitizeCloneLine(line: string): string {
  return (
    stripVTControlCharacters(line)
      // oxlint-disable-next-line no-control-regex -- Git diagnostics must not carry terminal controls into clients.
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\b[a-z][\w+.-]*:\/\/[^\s'"<>]*/gi, "[remote URL]")
      .replace(/\b[\w.+-]+@[^\s:]+:[^\s'"<>]+/g, "[remote URL]")
      .replace(/\b(?:authorization|proxy-authorization)\s*[:=].*/gi, "[credentials removed]")
      .replace(/\b(?:bearer|basic)\s+\S+/gi, "[credentials removed]")
      .replace(
        /\b(?:password|passwd|token|access_token|oauth_token|secret|api[_-]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
        "[credentials removed]",
      )
      .replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w-]+|glpat-[\w-]+)\b/g, "[credentials removed]")
      .trim()
      .slice(0, MAX_LINE)
  );
}

const AUTH_FAILURE =
  /authentication failed|permission denied|could not read (?:username|password)|terminal prompts disabled|repository not found|access denied|publickey/i;

const PROGRESS =
  /^(?:remote:\s*)?(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Checking out files):\s*(?:(\d+)%\s*\((\d+)\/(\d+)\)|(\d+))(?:,\s*([\d.]+)\s*([KMGT]?i?B)(?:\s*\|\s*([\d.]+)\s*([KMGT]?i?B)\/s)?)?/;

function bytes(value: string | undefined, unit: string | undefined): number | undefined {
  if (!value || !unit) return undefined;
  const exponent = ["B", "KB", "MB", "GB", "TB"].indexOf(unit.replace("i", ""));

  return exponent < 0 ? undefined : Number(value) * (unit.includes("i") ? 1024 : 1000) ** exponent;
}

/** CR and LF both finish a record. Retention and pending input are bounded independently of clone size. */
export class CloneReporter {
  readonly #decoder = new StringDecoder("utf8");
  #pending = "";
  #overflow = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #lastSent = 0;
  #dirty = false;
  #progress: CloneProgress;
  authenticationFailed = false;

  constructor(
    commandId: string,
    readonly receive: (progress: CloneProgress) => void,
    readonly activity: () => void,
  ) {
    this.#progress = create(CloneProgressSchema, { commandId, phase: "Cloning" });
  }

  write(chunk: Buffer): void {
    this.#read(this.#decoder.write(chunk));
  }

  #read(text: string): void {
    for (const part of text.split(/([\r\n])/)) {
      if (part === "\r" || part === "\n") {
        this.#line(this.#pending);
        this.#pending = "";
        this.#overflow = false;
      } else if (!this.#overflow) {
        this.#pending += part;

        if (this.#pending.length > MAX_PENDING) {
          // A diagnostic too long to inspect safely is replaced in its entirety, never split into raw fragments.
          this.#pending = "[Long Git output omitted]";
          this.#overflow = true;
        }
      }
    }
  }

  #line(raw: string): void {
    const line = sanitizeCloneLine(raw);

    if (!line) return;
    this.authenticationFailed ||= AUTH_FAILURE.test(line);
    const match = line.match(PROGRESS);

    if (match) {
      const next = {
        phase: match[1]!,
        percent: match[2] === undefined ? undefined : Math.min(100, Number(match[2])),
        completed: Number(match[3] ?? match[5]),
        total: match[4] === undefined ? undefined : Number(match[4]),
        bytes: bytes(match[6], match[7]),
        bytesPerSecond: bytes(match[8], match[9]),
      };

      if (
        next.phase !== this.#progress.phase ||
        next.completed !== this.#progress.completed ||
        next.bytes !== this.#progress.bytes
      )
        this.activity();
      this.#progress = create(CloneProgressSchema, { ...this.#progress, ...next });
    }

    if (this.#progress.lines.at(-1) !== line) this.#progress.lines = [...this.#progress.lines, line].slice(-MAX_LINES);
    this.#dirty = true;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer) return;
    const delay = Math.max(0, this.#lastSent + INTERVAL_MS - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#emit();
    }, delay);
  }

  #emit(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    this.#lastSent = Date.now();
    this.#progress.sequence++;
    this.receive(create(CloneProgressSchema, this.#progress));
  }

  /** Preserve the final diagnostics before CommandResult, without bypassing the throttle. */
  async finish(): Promise<void> {
    this.#read(this.#decoder.end());
    this.#line(this.#pending);
    this.#pending = "";
    clearTimeout(this.#timer);
    this.#timer = undefined;

    if (!this.#dirty) return;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, this.#lastSent + INTERVAL_MS - Date.now())));
    this.#emit();
  }
}
