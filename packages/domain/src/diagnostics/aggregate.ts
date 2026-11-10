import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { addCount, MAX_COUNT, Histogram } from "./histogram.ts";

export class Aggregate {
  started = 0n;
  completed = 0n;
  readonly codes = new BigUint64Array(17);
  readonly messageKinds = new BigUint64Array(8);
  readonly duration: Histogram;
  readonly requestBytes: Histogram;
  readonly responseBytes: Histogram;
  readonly firstMessage: Histogram;
  requestMessages = 0n;
  responseMessages = 0n;
  maxInFlight = 0;
  incomplete = false;
  slow = 0n;

  constructor(wide = false) {
    this.duration = new Histogram(false, wide);
    this.requestBytes = new Histogram(true, wide);
    this.responseBytes = new Histogram(true, wide);
    this.firstMessage = new Histogram(false, wide);
  }

  snapshot(methodId: number) {
    return create(ui.DiagnosticsAggregateSchema, {
      methodId,
      started: BigInt(this.started),
      completed: BigInt(this.completed),
      codes: Array.from(this.codes, BigInt),
      messageKinds: Array.from(this.messageKinds),
      duration: this.duration.snapshot(),
      requestBytes: this.requestBytes.snapshot(),
      responseBytes: this.responseBytes.snapshot(),
      firstMessage: this.firstMessage.snapshot(),
      requestMessages: BigInt(this.requestMessages),
      responseMessages: BigInt(this.responseMessages),
      maxInFlight: this.maxInFlight,
      slow: BigInt(this.slow),
      incomplete:
        [this.started, this.completed, this.requestMessages, this.responseMessages, this.slow, ...this.codes].some(
          (count) => count === MAX_COUNT,
        ) ||
        this.incomplete ||
        this.duration.incomplete ||
        this.requestBytes.incomplete ||
        this.responseBytes.incomplete ||
        this.firstMessage.incomplete,
    });
  }

  merge(value: ui.DiagnosticsAggregate | Aggregate) {
    this.started = addCount(this.started, value.started);
    this.completed = addCount(this.completed, value.completed);

    for (let i = 0; i < 17; i++) this.codes[i] = addCount(this.codes[i]!, value.codes[i] ?? 0n);

    for (let i = 0; i < 8; i++) this.messageKinds[i] = addCount(this.messageKinds[i]!, value.messageKinds[i] ?? 0n);

    if (value.duration) this.duration.merge(value.duration);

    if (value.requestBytes) this.requestBytes.merge(value.requestBytes);

    if (value.responseBytes) this.responseBytes.merge(value.responseBytes);

    if (value.firstMessage) this.firstMessage.merge(value.firstMessage);
    this.requestMessages = addCount(this.requestMessages, value.requestMessages);
    this.responseMessages = addCount(this.responseMessages, value.responseMessages);
    this.maxInFlight = Math.max(this.maxInFlight, value.maxInFlight);
    this.incomplete ||= value.incomplete;
    this.slow = addCount(this.slow, value.slow);
  }
}

export function mergeAggregates(values: readonly ui.DiagnosticsAggregate[], methodId: number) {
  const result = new Aggregate(true);

  for (const value of values) result.merge(value);

  return result.snapshot(methodId);
}

export function mergeCoverage(values: readonly ui.DiagnosticsCoverage[]) {
  const result: ui.DiagnosticsCoverage[] = [];

  for (const item of [...values].sort((a, b) => Number(a.startMs - b.startMs))) {
    const last = result.at(-1);

    if (last && item.startMs <= last.endMs) last.endMs = last.endMs > item.endMs ? last.endMs : item.endMs;
    else result.push(create(ui.DiagnosticsCoverageSchema, item));
  }

  return result;
}
