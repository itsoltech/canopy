import type { DiagnosticsPhase } from "./diagnostics-load.ts";

export function selectedPhases(): DiagnosticsPhase[] {
  const only = process.env["CANOPY_BENCH_ONLY_PHASE"];

  if (only === "steady" || only === "write_failure" || only === "pool_contention" || only === "log_export")
    return [only];
  const forensicPhase = process.env["CANOPY_BENCH_FORENSIC_PHASE"];

  if (process.env["CANOPY_BENCH_FORENSICS_DIR"] && forensicPhase) {
    if (forensicPhase === "steady" || forensicPhase === "slow_reader" || forensicPhase === "governor")
      return [forensicPhase];

    if (forensicPhase === "write_failure") return ["slow_reader", "write_failure"];

    if (forensicPhase === "write_failure_without_watches") return ["write_failure"];
    throw new Error("Choose steady, slow_reader, write_failure, write_failure_without_watches or governor");
  }

  if (process.env["CANOPY_BENCH_RESOURCES"] === "1") return ["idle"];

  if (process.env["CANOPY_BENCH_ALL_PHASES"] === "1")
    return [
      "idle",
      "steady",
      "reconnect",
      "slow_reader",
      "write_failure",
      "pool_contention",
      ...(["2", "3", "4", "5"].includes(process.env["CANOPY_BENCH_STAGE"] ?? "") ? ["governor" as const] : []),
      ...(["4", "5"].includes(process.env["CANOPY_BENCH_STAGE"] ?? "") ? ["report" as const] : []),
      ...(process.env["CANOPY_BENCH_STAGE"] === "5" ? ["log_export" as const] : []),
    ];

  if (process.env["CANOPY_BENCH_CONTENTION"] === "1") return ["write_failure", "pool_contention"];

  if (process.env["CANOPY_BENCH_CHURN"] === "1") return ["churn"];

  if (process.env["CANOPY_BENCH_EXTRA_PHASES"] === "1") return ["reconnect", "slow_reader"];

  return ["idle", "steady"];
}
