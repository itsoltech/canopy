import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ProviderUsageWindowSchema, type ProviderUsageWindow } from "@canopy/contracts";
import { isUsageResetPlausible } from "@canopy/domain/provider-usage";
import { Option, Schema } from "effect";

const MAX_BYTES = 512 * 1024;

const Window = Schema.Struct({
  utilization: Schema.NullOr(Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 100 }))),
  resets_at: Schema.NullOr(Schema.String),
});

const Usage = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(Window)),
  seven_day: Schema.optional(Schema.NullOr(Window)),
  seven_day_opus: Schema.optional(Schema.NullOr(Window)),
  seven_day_sonnet: Schema.optional(Schema.NullOr(Window)),
});

const decodeUsage = Schema.decodeUnknownOption(Usage);

const decodeEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({ status_code: Schema.Literal(200), body: Schema.String }),
);

/** Read at most the management envelope limit, cancelling any remaining response bytes. */
async function readBody(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();

  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) return Buffer.concat(chunks).toString("utf8");

    if (size + value.byteLength > MAX_BYTES) {
      await reader.cancel().catch(() => {});

      return undefined;
    }

    size += value.byteLength;
    chunks.push(value);
  }
}

/** Only numeric balances and plausible reset dates leave the upstream usage response. */
function usageWindows(usage: typeof Usage.Type, now: number): ProviderUsageWindow[] | undefined {
  const windows: ProviderUsageWindow[] = [];

  for (const key of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const) {
    const value = usage[key];

    if (!value) continue;
    const used = value.utilization;
    const resetAt = value.resets_at === null ? undefined : Date.parse(value.resets_at);

    if (resetAt !== undefined && !isUsageResetPlausible(resetAt, now)) return undefined;

    if (used === null) continue;
    windows.push(
      create(ProviderUsageWindowSchema, {
        key,
        windowMinutes: key === "five_hour" ? 300 : 10080,
        usedPercent: used,
        resetsAt: resetAt === undefined ? undefined : timestampFromDate(new Date(resetAt)),
        reached: used >= 100,
      }),
    );
  }

  return windows.length ? windows : undefined;
}

/** CLIProxyAPI substitutes the selected credential token; Canopy receives only the usage result. */
export async function readClaudeProxyUsage(
  root: string,
  key: string,
  authIndex: string,
  signal: AbortSignal,
  now: number,
): Promise<ProviderUsageWindow[] | undefined> {
  if (!key || !authIndex) return undefined;

  try {
    const response = await fetch(`${root}/v0/management/api-call`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_index: authIndex,
        method: "GET",
        url: "https://api.anthropic.com/api/oauth/usage",
        header: {
          Authorization: "Bearer $TOKEN$",
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
        },
      }),
    });

    const body = await readBody(response);

    if (!response.ok || body === undefined) return undefined;
    const envelope = decodeEnvelope(JSON.parse(body));

    if (Option.isNone(envelope)) return undefined;
    const usage = decodeUsage(JSON.parse(envelope.value.body));

    return Option.isSome(usage) ? usageWindows(usage.value, now) : undefined;
  } catch {
    return undefined;
  }
}
