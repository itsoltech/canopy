import { toBinary } from "@bufbuild/protobuf";
import { heapStats } from "bun:jsc";
import { ui } from "@canopy/contracts";
import { DiagnosticsTrace, TRACE_LIMITS } from "@canopy/domain/diagnostics";

let now = 1000;

const trace = new DiagnosticsTrace(
  () => now,
  () => now,
);

function session() {
  const lease = crypto.randomUUID();

  if (!trace.start(lease, "gateway", 5)) throw new Error("Trace did not start");

  for (let second = 0; second <= Math.ceil(TRACE_LIMITS.samples / TRACE_LIMITS.perSecond); second++) {
    now += 1000;

    for (let call = 0; call < TRACE_LIMITS.perSecond * TRACE_LIMITS.stride; call++)
      trace.record("rpc", 22, call % 100, call % 3 === 0);
  }

  const exported = trace.export(lease)!;

  if (exported.spans.length !== TRACE_LIMITS.samples) throw new Error("Trace ring did not saturate");
  toBinary(ui.DiagnosticsTraceExportSchema, exported);
  trace.stop(lease);

  return lease;
}

async function sample(cycle: number, phase: string) {
  await Bun.sleep(0);
  Bun.gc(true);
  await Bun.sleep(0);
  Bun.gc(true);
  const stats = heapStats();

  console.info(JSON.stringify({ cycle, phase, heap: process.memoryUsage().heapUsed, objects: stats.objectCount }));
}

// Warm protobuf export and sampling code before comparing retained memory.
for (let cycle = 0; cycle < 3; cycle++) {
  session();
  trace.clear();
}

await sample(-1, "baseline");

for (let cycle = 0; cycle < 12; cycle++) {
  const lease = session();
  await sample(cycle, "stopped");

  // Export remains available after stop, but expires ten minutes later.
  now += 600_001;

  if (trace.export(lease)) throw new Error("Trace survived export retention TTL");
  await sample(cycle, "purged");
}
