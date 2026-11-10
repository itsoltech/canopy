import { appendFileSync, existsSync, readFileSync, realpathSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { Schema } from "effect";

export const ProbeRecord = Schema.Struct({
  event: Schema.String,
  harness: Schema.String,
  pid: Schema.Number,
  home: Schema.String,
  probe: Schema.String,
  proxy: Schema.Boolean,
  credentialMatches: Schema.Boolean,
  session: Schema.String,
  provider: Schema.String,
});

export type ProbeRecord = typeof ProbeRecord.Type;

export const InputPart = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String),
});

export const InputRecord = Schema.Struct({ harness: Schema.String, parts: Schema.Array(InputPart) });

export type InputRecord = typeof InputRecord.Type;

const inputsOf = (trace: string) => join(dirname(trace), "inputs.jsonl");

/** What a harness got as the user's content, in order: texts and images (an image by its type or file name). */
export function recordInput(harness: string, parts: readonly (typeof InputPart.Type)[]): void {
  const trace = process.env["INSTANCE_TRACE"];

  if (trace) appendFileSync(inputsOf(trace), JSON.stringify({ harness, parts }) + "\n");
}

export function inputRecords(trace: string): InputRecord[] {
  const path = inputsOf(trace);

  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .slice(0, -1)
        .filter(Boolean)
        .map((line) => Schema.decodeSync(Schema.fromJsonString(InputRecord))(line))
    : [];
}

/** Harness processes append while tests poll: a line without its newline is still being written, not a record yet. */
export function probeRecords(path: string): ProbeRecord[] {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .slice(0, -1)
        .filter(Boolean)
        .map((line) => Schema.decodeSync(Schema.fromJsonString(ProbeRecord))(line))
    : [];
}

/** Fixture metadata only. Never records credentials, env dumps or argv. */
export function recordProbe(harness: string, event: string, session = "", provider = ""): void {
  const env = process.env;
  const trace = env["INSTANCE_TRACE"];

  if (!trace) return;
  const probe = env["PROFILE_PROBE"] ?? "";

  const home =
    harness === "grok"
      ? realpathSync(join(env["GROK_HOME"]!, "sessions"))
      : (env[harness === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] ?? "");

  const proxy = !!(env["ANTHROPIC_AUTH_TOKEN"] || env["CANOPY_NATIVE_API_KEY"] || env["CANOPY_GROK_API_KEY"]);
  const credentialMatches = !probe || env["INSTANCE_SECRET"] === `fixture-secret-${probe}`;
  appendFileSync(
    trace,
    JSON.stringify({ event, harness, pid: process.pid, home, probe, proxy, credentialMatches, session, provider }) +
      "\n",
  );
}

export async function releaseProbe(text: string): Promise<void> {
  text = text.split("\n\nCurrent input:\n").at(-1) ?? text;
  const label = text.match(/HOLD:([a-z0-9-]+)/)?.[1];
  const trace = process.env["INSTANCE_TRACE"];

  if (!label || !trace) return;
  const marker = join(dirname(trace), `release-${label}`);

  if (existsSync(marker)) return;
  await new Promise<void>((resolve) => {
    const watcher = watch(dirname(trace), () => {
      if (!existsSync(marker)) return;
      watcher.close();
      resolve();
    });

    if (existsSync(marker)) {
      watcher.close();
      resolve();
    }
  });
}
