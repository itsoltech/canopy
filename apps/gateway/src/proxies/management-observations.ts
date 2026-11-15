import { Option, Schema } from "effect";
import { proxyUsageWindows } from "./management-usage.ts";

const Text = Schema.optional(Schema.NullOr(Schema.String));

/** Both credential and model quotas carry passive response headers with their own observation time. */
export const QuotaObservation = Schema.Struct({
  observed_at: Text,
  signals: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
});

/** Decode models individually so one malformed observation cannot hide a readable account. */
export const ModelObservations = Schema.Record(Schema.String, Schema.Unknown);

const decodeObservation = Schema.decodeUnknownOption(QuotaObservation);

const observedDate = (value: string | null | undefined) => {
  const date = value ? new Date(value) : undefined;

  return date && Number.isFinite(date.getTime()) && date.getTime() > 0 && date.getFullYear() < 9999 ? date : undefined;
};

/** Resolve each window atomically: a newer model response can supersede a stale credential observation. */
export function proxyObservations(
  quota: typeof QuotaObservation.Type | null | undefined,
  modelQuotas: typeof ModelObservations.Type | null | undefined,
  now: number,
) {
  const observations = [
    ...(quota ? [quota] : []),
    ...Object.values(modelQuotas ?? {}).flatMap((value) => Option.toArray(decodeObservation(value))),
  ]
    .map((value) => ({ value, observed: observedDate(value.observed_at) }))
    .sort((a, b) => (a.observed?.getTime() ?? 0) - (b.observed?.getTime() ?? 0));

  const signals = new Map<string, string>();
  const windows = new Map<string, { window: ReturnType<typeof proxyUsageWindows>[number]; at: number }>();

  for (const { value, observed } of observations) {
    const headers = new Map(Object.entries(value.signals ?? {}).map(([key, text]) => [key.toLowerCase(), text.trim()]));

    for (const [key, text] of headers) signals.set(key, text);

    for (const window of proxyUsageWindows(headers, observed, now)) {
      const identity = `${window.key}:${window.windowMinutes}`;
      const previous = windows.get(identity);
      const at = observed?.getTime() ?? 0;
      const used = window.reached ? 100 : (window.usedPercent ?? -1);
      const previousUsed = previous?.window.reached ? 100 : (previous?.window.usedPercent ?? -1);

      // Equal or missing timestamps must not make the balance depend on model enumeration order.
      if (!previous || at > previous.at || (at === previous.at && used > previousUsed))
        windows.set(identity, { window, at });
    }
  }

  return { signals, windows: [...windows.values()].map(({ window }) => window) };
}
