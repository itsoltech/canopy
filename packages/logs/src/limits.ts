export const LOG_SOURCES = ["desktop", "gateway", "worker", "postgres", "web", "initdb"] as const;

export type LogSource = (typeof LOG_SOURCES)[number];

export const LOG_LIMITS = {
  line: 16 * 1024,
  rotation: 5 * 1024 * 1024,
  files: 4,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  scan: 128 * 1024 * 1024,
  source: 2 * 1024 * 1024,
  home: 12 * 1024 * 1024,
  action: 96 * 1024 * 1024,
  zip: 100 * 1024 * 1024,
  chunk: 32 * 1024,
  ttlMs: 15 * 60 * 1000,
} as const;

export function logSource(value: string): LogSource | undefined {
  return LOG_SOURCES.find((source) => source === value);
}

export type SourceStatus = "done" | "truncated" | "not_available" | "omitted" | "timed_out";

export interface LogCoverage {
  source: LogSource;
  status: SourceStatus;
  bytes: number;
  records: number;
  omittedRecords: number;
  omittedBytes: number;
  redactedRecords: number;
  firstAtMs: number;
  lastAtMs: number;
  legacy: boolean;
  rotationVerified: boolean;
}
