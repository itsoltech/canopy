import { hasEffectiveCost, metricNumber, shortCount, type UsageDay, type UsageRow, type UsageView } from "./format.ts";

// Two intervals on the cost axis need at least one cent each for distinct labels.
const minimumCostRange = 0.02;

const costAxis = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  notation: "compact",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export interface UsagePoint {
  x: number;
  y: number;
}

function value(day: UsageDay, provider: string, view: UsageView): number | null {
  const part = day.providers.find((row) => row.key === provider);

  if (!part) return day.providers.length || day.amounts.reports === 0n ? 0 : null;

  if (view === "cost" && !hasEffectiveCost(part.amounts)) return null;

  return metricNumber(part.amounts, view);
}

function ceiling(peak: number): number {
  if (peak <= 0) return 1;
  const unit = 10 ** Math.floor(Math.log10(peak));

  return Math.ceil(peak / unit) * unit;
}

export function pointX(index: number, length: number): number {
  return length > 0 ? ((index + 0.5) / length) * 1000 : 500;
}

/** Monotone cubic interpolation rounds evenly spaced daily points without overshooting their values. */
function smoothLine(points: UsagePoint[]): string {
  const first = points[0];

  if (!first) return "";

  if (points.length === 1) return `M${first.x},${first.y} L${first.x},${first.y}`;

  // SAFETY: slicing from index 1 leaves one preceding point for every secant.
  const slopes = points.slice(1).map((point, index) => (point.y - points[index]!.y) / (point.x - points[index]!.x));

  const tangents = points.map((_, index) => {
    const before = slopes[index - 1];
    const after = slopes[index];

    if (before === undefined) return after ?? 0;

    if (after === undefined) return before;

    return before * after <= 0 ? 0 : (2 * before * after) / (before + after);
  });

  const segments = points.slice(1).map((point, index) => {
    // SAFETY: every sliced point has a predecessor; tangents contains one entry per original point.
    const previous = points[index]!;
    const width = (point.x - previous.x) / 3;
    const fromY = previous.y + tangents[index]! * width;
    const toY = point.y - tangents[index + 1]! * width;

    return `C${previous.x + width},${fromY} ${point.x - width},${toY} ${point.x},${point.y}`;
  });

  return `M${first.x},${first.y} ${segments.join(" ")}`;
}

function paths(points: (UsagePoint | null)[]) {
  const groups: UsagePoint[][] = [];
  let group: UsagePoint[] = [];

  for (const point of points) {
    if (point) group.push(point);
    else if (group.length) {
      groups.push(group);
      group = [];
    }
  }

  if (group.length) groups.push(group);

  return groups.map((points) => {
    // SAFETY: groups are only appended when nonempty.
    const first = points[0]!;
    const last = points.at(-1)!;
    const line = smoothLine(points);

    return {
      line,
      area: points.length > 1 ? `${line} L${last.x},196 L${first.x},196 Z` : "",
      single: points.length === 1,
    };
  });
}

export function plotUsage(days: UsageDay[], providers: UsageRow[], view: UsageView) {
  const values = providers.map((provider) => ({
    key: provider.key,
    values: days.map((day) => value(day, provider.key, view)),
  }));

  const peak = Math.max(0, ...values.flatMap((series) => series.values.map((value) => value ?? 0)));
  const maximum = view === "cost" ? Math.max(minimumCostRange, ceiling(peak)) : ceiling(peak);

  return {
    maximum,
    series: values.map((series) => {
      const points = series.values.map((value, index) =>
        value === null ? null : { x: pointX(index, days.length), y: 196 - (value / maximum) * 192 },
      );

      return { key: series.key, points, paths: paths(points) };
    }),
  };
}

export function axisLabel(value: number, view: UsageView): string {
  if (view === "cost") return costAxis.format(value);

  // The middle tick can fall between two tokens on small ranges.
  return Number.isInteger(value) ? shortCount(BigInt(value)) : String(value);
}
