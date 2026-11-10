import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Aggregate, mergeCoverage, percentiles } from "@canopy/domain/diagnostics";
import { Code, ConnectError } from "@connectrpc/connect";
import type { RpcCollector } from "./collector.ts";

export function windowMinutes(value: number) {
  if (!value) return 15;

  if (![1, 15, 60, 1440].includes(value))
    throw new ConnectError("Choose an available time range", Code.InvalidArgument);

  return value;
}

export function rpcSnapshot(collector: RpcCollector, minutes: number) {
  const now = collector.clock.utc();
  let ring = collector.minutes;

  if (minutes === 1) ring = collector.short;

  if (minutes === 1440) ring = collector.quarters;
  const start = Math.floor(now / ring.width) * ring.width - (minutes * 60_000 - ring.width);
  const slots = ring.between(start, now + 1);

  if (minutes !== 1) {
    const history = minutes === 1440 ? collector.historyQuarters : collector.historyMinutes;
    slots.push(...history.between(start, now + 1));
  }

  const coverage = mergeCoverage(slots.flatMap((slot) => slot.coverage));
  const observedSeconds = coverage.reduce((sum, value) => sum + Number(value.endMs - value.startMs) / 1000, 0);
  const aggregates = new Map<number, Aggregate>();

  for (const slot of slots)
    for (const [id, value] of slot.series) {
      const aggregate = aggregates.get(id) ?? new Aggregate(true);
      aggregate.merge(value.snapshot(id));
      aggregates.set(id, aggregate);
    }

  const calls = [...aggregates].flatMap(([id, aggregate]) => {
    const method = collector.methods.get(id);

    if (!method) return [];
    const active = collector.active.get(id);
    const mono = collector.clock.monotonic();
    const value = aggregate.snapshot(id);

    return [
      create(ui.DiagnosticsCallSchema, {
        method: method.name,
        layer: method.layer,
        stream: method.stream,
        started: value.started,
        completed: value.completed,
        callsPerMinute: observedSeconds ? (Number(aggregate.started) * 60) / observedSeconds : 0,
        codes: value.codes,
        inFlight: active?.size ?? 0,
        maxInFlight: value.maxInFlight,
        durationMs: percentiles(value.duration ? [value.duration] : []),
        requestBytes: percentiles(value.requestBytes ? [value.requestBytes] : [], true),
        responseBytes: percentiles(value.responseBytes ? [value.responseBytes] : [], true),
        firstMessageMs: percentiles(value.firstMessage ? [value.firstMessage] : []),
        requestMessages: value.requestMessages,
        responseMessages: value.responseMessages,
        messageKinds: value.messageKinds,
        oldestActiveMs: active?.size ? Math.max(0, mono - Math.min(...active.values())) : 0,
        incomplete: value.incomplete,
        slow: value.slow,
      }),
    ];
  });

  // Streams opened outside the selected window still have current gauges.
  for (const [id, active] of collector.active) {
    if (!active.size || aggregates.has(id)) continue;
    const method = collector.methods.get(id);

    if (method)
      calls.push(
        create(ui.DiagnosticsCallSchema, {
          method: method.name,
          layer: method.layer,
          stream: method.stream,
          inFlight: active.size,
          oldestActiveMs: collector.clock.monotonic() - Math.min(...active.values()),
        }),
      );
  }

  const gaps: ui.DiagnosticsCoverage[] = [];
  let covered = start;

  for (const range of coverage) {
    if (Number(range.startMs) > covered)
      gaps.push(
        create(ui.DiagnosticsCoverageSchema, {
          startMs: BigInt(covered),
          endMs: range.startMs,
        }),
      );
    covered = Math.max(covered, Number(range.endMs));
  }

  if (now - covered > 10_000)
    gaps.push(
      create(ui.DiagnosticsCoverageSchema, {
        startMs: BigInt(covered),
        endMs: BigInt(now),
      }),
    );

  return {
    calls,
    gaps,
    observedSeconds,
    windowStartMs: BigInt(start),
    windowEndMs: BigInt(now),
    resolutionSeconds: ring.width / 1000,
  };
}
