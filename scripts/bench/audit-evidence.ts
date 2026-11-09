import { Glob } from "bun";
import { Schema } from "effect";
import { join } from "node:path";

const source = Schema.Struct({ file: Schema.String, line: Schema.Number });

const plan = Schema.Struct({
  fingerprint: Schema.String,
  sources: Schema.optional(Schema.Array(source)),
  executionMs: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  skipped: Schema.optional(Schema.String),
});

const document = Schema.Struct({
  plans: Schema.optional(Schema.Array(plan)),
  results: Schema.optional(Schema.Array(Schema.Struct({ plans: Schema.optional(Schema.Array(plan)) }))),
});

export interface AuditEvidence {
  readonly fingerprint: string;
  readonly kind: "benchmark" | "integration";
  readonly status: "explained" | "error" | "skipped";
}

/** Reads only explicitly selected private artifacts; no SQL, parameters or returned values enter the report. */
export async function auditEvidence(directories: readonly { path: string; kind: AuditEvidence["kind"] }[]) {
  const matched = new Map<string, AuditEvidence[]>();
  const fingerprints = new Set<string>();
  let unmatchedPlans = 0;
  let errors = 0;

  for (const directory of directories) {
    for await (const file of new Glob("*.json").scan(directory.path)) {
      const data = Schema.decodeUnknownSync(document)(await Bun.file(join(directory.path, file)).json());

      for (const item of [...(data.plans ?? []), ...(data.results ?? []).flatMap((result) => result.plans ?? [])]) {
        fingerprints.add(item.fingerprint);
        const status = item.error ? "error" : item.skipped ? "skipped" : "explained";

        if (status === "error") errors++;

        if (!item.sources?.length) unmatchedPlans++;

        for (const location of item.sources ?? []) {
          const key = `${location.file}:${location.line}`;
          const entries = matched.get(key) ?? [];

          if (
            !entries.some(
              (entry) =>
                entry.fingerprint === item.fingerprint && entry.kind === directory.kind && entry.status === status,
            )
          )
            entries.push({ fingerprint: item.fingerprint, kind: directory.kind, status });
          matched.set(key, entries);
        }
      }
    }
  }

  return { matched, uniqueFingerprints: fingerprints.size, unmatchedPlans, errors };
}
