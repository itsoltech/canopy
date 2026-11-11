import {
  Measure,
  METRIC_DEFINITIONS,
  databaseMetric,
  DATABASE_FAMILIES,
  governorMetric,
} from "@canopy/domain/diagnostics";

/** Numeric, deterministic fixtures for gateway details, including last-known resource samples. */
export function syntheticGatewayMeasures(at: number, rpc: number) {
  const result = [];

  for (const definition of METRIC_DEFINITIONS.values()) {
    if (definition.id >= 1000) continue;
    const measure = new Measure();

    if (definition.kind === "timing") {
      for (let i = 0; i < 100; i++) measure.timing(i < 95 ? 2 : 125, false, at);
    } else if (definition.kind === "counter") measure.counter(200, false, at);
    else {
      const value = definition.unit === "bytes" ? 128 * 1024 * 1024 : definition.id === 2 ? 23.4 : 3;
      measure.gauge(value, 60_000, at);
    }

    result.push(measure.snapshot(definition.id));
  }

  for (const family of DATABASE_FAMILIES)
    for (const phase of ["reserve", "execute", "release", "transaction"] as const) {
      const value = new Measure();

      for (let i = 0; i < 40; i++) value.timing(phase === "execute" ? 5 + family.id : 0.2, i === 39, at);
      result.push(value.snapshot(databaseMetric(family.name, phase)));

      if (family.id === 1) result.push(value.snapshot(databaseMetric(family.name, phase), rpc));
    }

  for (const event of ["attempt", "admitted", "wait", "execution", "full", "cancelled", "joined", "cached"] as const) {
    const value = new Measure();

    if (event === "wait" || event === "execution") value.timing(20, false, at);
    else value.counter(40, false, at);
    result.push(value.snapshot(governorMetric("git", "user", event)));
  }

  return result;
}
