import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Aggregate, mergeCoverage, percentiles } from "@canopy/domain/diagnostics";
import { Code, ConnectError } from "@connectrpc/connect";
import type { RpcCollector } from "./collector.ts";
import type { Slot } from "./buckets.ts";
import { closedWindow } from "./windows.ts";
import { measureSnapshot } from "./measure-snapshot.ts";

export function windowMinutes(value: number) {
  if (!value) return 15;

  if (![1, 15, 60, 1440].includes(value))
    throw new ConnectError("Choose an available time range", Code.InvalidArgument);

  return value;
}

export function rpcSnapshot(collector: RpcCollector, minutes: number, hourly?: Slot) {
  const now = collector.clock.utc();
  let width = 60_000;

  if (minutes === 1) width = 5000;

  if (minutes === 1440) width = 3_600_000;
  const start = Math.floor(now / width) * width - (minutes * 60_000 - width);
  const current = Math.floor(now / 60_000) * 60_000;
  const liveStart = minutes === 1440 ? Math.floor(now / 3_600_000) * 3_600_000 : start;

  const slots =
    minutes === 1
      ? collector.short.between(start, now + 1)
      : [...collector.minutes.between(current, now + 1), ...collector.historyMinutes.between(current, now + 1)];

  const sources: ReadonlyMap<number, Aggregate>[] = slots.map((slot) => slot.series);
  let ranges = slots.flatMap((slot) => slot.coverage);

  if (minutes !== 1) {
    const closed = closedWindow(collector, minutes, liveStart, current);

    if (closed.limited) for (const slot of closed.slots) sources.push(slot.series);
    else sources.push(closed.values);
    ranges = ranges.concat(closed.coverage);

    if (hourly) {
      sources.push(hourly.series);
      ranges = ranges.concat(hourly.coverage);
    }
  }

  const coverage = mergeCoverage(ranges);
  const observedSeconds = coverage.reduce((sum, value) => sum + Number(value.endMs - value.startMs) / 1000, 0);
  const aggregates = new Map<number, Aggregate>();

  for (const source of sources)
    for (const [id, value] of source) {
      const aggregate = aggregates.get(id) ?? new Aggregate(true);
      aggregate.merge(value);
      aggregates.set(id, aggregate);
    }

  const measured = measureSnapshot(collector, minutes, hourly);

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
        database: measured.associated.get(id) ?? [],
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
    gatewayMeasures: measured.gatewayMeasures,
    database: measured.database,
    gaps,
    observedSeconds,
    windowStartMs: BigInt(start),
    windowEndMs: BigInt(now),
    resolutionSeconds: width / 1000,
  };
}
