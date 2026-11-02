export function numberBound(value: string | number | null | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function parseNumber(value: string): number | undefined {
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return undefined;
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) ? number : undefined;
}

export function clampNumber(value: number, min = -Infinity, max = Infinity): number {
  return Math.min(max, Math.max(min, value));
}

/** Step on the grid anchored at min (or zero), without floating point accumulation. */
export function stepNumber(value: number | undefined, direction: number, step = 1, min = -Infinity, max = Infinity): number {
  const increment = Number.isFinite(step) && step > 0 ? step : 1;
  const base = Number.isFinite(min) ? min : 0;
  if (value === undefined) return clampNumber(direction > 0 ? increment : -increment, min, max);
  const position = (value - base) / increment;
  const next = direction > 0 ? Math.floor(position + 1e-9) + 1 : Math.ceil(position - 1e-9) - 1;
  return clampNumber(Number((base + next * increment).toPrecision(14)), min, max);
}
