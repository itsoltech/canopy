import type { ui } from "@canopy/contracts";

const LIMIT_COPY = new Map([
  ["memory", "Some performance details exceeded the measurement memory limit."],
  ["sql_buffer", "Some database timings arrived faster than Canopy could collect them."],
  ["correlations", "Some per-call database details exceeded the series limit."],
  ["coverage", "Some observation periods exceeded the coverage limit."],
  ["history", "Some saved measurements exceeded the history memory limit."],
  ["collection", "Some call or event measurements exceeded the collection limit."],
  ["persistence", "Some measurements could not fit in saved history."],
  ["links", "Some computer or worker measurements exceeded the link limit."],
  ["response", "Some details exceeded the response size limit."],
  ["invalid", "Some received measurements failed validation."],
]);

export function diagnosticsLimits(computer: ui.ComputerDiagnostics) {
  if (!computer.droppedSamples) return [];
  const messages = [...new Set(computer.limitReasons)].flatMap((reason) => LIMIT_COPY.get(reason) ?? []);

  return messages.length ? messages : ["Some measurements are missing. This computer did not report a reason."];
}

export function diagnosticsGap(gap: ui.DiagnosticsCoverage) {
  const seconds = Math.max(0, Number(gap.endMs - gap.startMs) / 1000);

  const duration = new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: seconds < 60 ? "second" : "minute",
    unitDisplay: "short",
    maximumFractionDigits: seconds < 60 ? 0 : 1,
  }).format(seconds < 60 ? seconds : seconds / 60);

  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(Number(gap.startMs));

  return `Gap of ${duration} at ${time}.`;
}
