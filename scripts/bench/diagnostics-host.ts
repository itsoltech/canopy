import { cpus } from "node:os";
import { SwapGate, swapCounters, pageSize } from "./diagnostics-swap.ts";
import { monitorScopes, swapDisabledStage } from "./diagnostics-scope.ts";

export function pinnedCommand(env: Record<string, string | undefined>, role: "GATEWAY" | "WORKER", args: string[]) {
  const cpu = env[`CANOPY_BENCH_${role}_CPU`];

  if (!cpu) return args;

  if (!/^\d+$/.test(cpu)) throw new Error("Choose one CPU per benchmark process");

  return ["taskset", "-c", cpu, ...args];
}

/** vmstat's first data row is since boot; subsequent rows describe the measured second. */
export async function monitorHost(pair: number, attempt: number, postgresScope?: string) {
  const loadavg = (await Bun.file("/proc/loadavg").text()).trim();
  const cpuCount = cpus().length;
  const before = await swapCounters();
  const bytesPerPage = await pageSize();
  const abort = new AbortController();
  const violations: { kind: string; value: string }[] = [];
  let activity: Promise<void> | undefined;

  const reject = (kind: string, value: string) => {
    if (violations.length < 20) violations.push({ kind, value });

    // Capture once at rejection, outside accepted recordings. Never include argv or environment values.
    if (!abort.signal.aborted) activity = rejectedProcesses(pair, attempt, kind);
    abort.abort();
  };

  const swapDisabled = swapDisabledStage();
  const swap = new SwapGate(reject, swapDisabled);
  const sampleScopes = await monitorScopes(postgresScope, reject);
  const scopeBefore = await sampleScopes();

  if (Number(loadavg.split(" ")[0]) > cpuCount) reject("load", loadavg);
  console.info(
    JSON.stringify({
      phase: "host_begin",
      pair,
      attempt,
      loadavg,
      cpus: cpuCount,
      swap: before,
      bytesPerPage,
      scopes: scopeBefore,
    }),
  );
  const vmstat = Bun.spawn(["vmstat", "-w", "-S", "K", "1"], { stdout: "pipe", stderr: "inherit" });
  let stopping = false;
  let samples = 0;
  let maxLoad = Number(loadavg.split(" ")[0]);

  const reading = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();

    for await (const chunk of vmstat.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;

      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);

        if (!/^\d+\s/.test(line)) continue;

        if (++samples === 1) continue;
        const values = line.split(/\s+/).map(Number);

        if (values.length < 16 || values.some((value) => !Number.isFinite(value))) {
          reject("monitor_invalid_sample", line);
          continue;
        }

        const load = (await Bun.file("/proc/loadavg").text()).trim();
        maxLoad = Math.max(maxLoad, Number(load.split(" ")[0]));
        console.info(
          JSON.stringify({
            phase: "host_sample",
            pair,
            attempt,
            loadavg: load,
            vmstat: line,
            scopes: await sampleScopes(),
          }),
        );

        swap.sample(values[6]!, values[7]!);
        swap.cumulative(((await swapCounters()).output - before.output) * bytesPerPage);

        if (maxLoad > cpuCount) reject("load", load);
      }
    }

    if (!stopping) reject("monitor_exited", "vmstat exited before the pair completed");
  })().catch(() => reject("monitor_failed", "Host sampling failed"));

  return {
    signal: abort.signal,
    assertQuiet() {
      if (abort.signal.aborted) throw new Error("Benchmark pair invalidated by host noise");
    },
    async stop(completed: boolean) {
      stopping = true;
      vmstat.kill("SIGTERM");
      await reading;
      await vmstat.exited;
      const after = await swapCounters();
      const scopeAfter = await sampleScopes();

      swap.cumulative((after.output - before.output) * bytesPerPage);
      await activity;
      const accepted = completed && !abort.signal.aborted;
      console.info(
        JSON.stringify({
          phase: "pair_end",
          pair,
          attempt,
          accepted,
          maxLoad,
          samples: samples - 1,
          swapInPages: after.input - before.input,
          swapOutPages: after.output - before.output,
          swapInBytes: (after.input - before.input) * bytesPerPage,
          swapOutBytes: (after.output - before.output) * bytesPerPage,
          peakSwapInKiBPerSec: swap.peakInputKiB,
          peakSwapOutKiBPerSec: swap.peakOutputKiB,
          swapInSustainedThresholdKiBPerSec: swap.sustainedInputKiB,
          longestSwapInThresholdRun: swap.longestInput,
          swapOutThresholdKiBPerSec: swapDisabled ? 4096 : 128,
          scopes: scopeAfter,
          violations,
        }),
      );

      return accepted;
    },
  };
}

async function rejectedProcesses(pair: number, attempt: number, reason: string) {
  const atMs = Date.now();

  try {
    const child = Bun.spawn(["ps", "-eo", "pid,ppid,etimes,pcpu,rss,comm", "--sort=-rss"], {
      stdout: "pipe",
      stderr: "ignore",
    });

    const processes = (await new Response(child.stdout).text()).slice(0, 65536);
    const exitCode = await child.exited;

    console.info(JSON.stringify({ phase: "host_processes", pair, attempt, atMs, reason, exitCode, processes }));
  } catch {
    console.info(JSON.stringify({ phase: "host_processes", pair, attempt, atMs, reason, unavailable: true }));
  }
}
