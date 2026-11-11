import { cpus } from "node:os";
import { SwapGate, swapCounters, pageSize } from "./diagnostics-swap.ts";

export function pinnedCommand(env: Record<string, string | undefined>, role: "GATEWAY" | "WORKER", args: string[]) {
  const cpu = env[`CANOPY_BENCH_${role}_CPU`];

  if (!cpu) return args;

  if (!/^\d+$/.test(cpu)) throw new Error("Choose one CPU per benchmark process");

  return ["taskset", "-c", cpu, ...args];
}

/** vmstat's first data row is since boot; subsequent rows describe the measured second. */
export async function monitorHost(pair: number, attempt: number) {
  const loadavg = (await Bun.file("/proc/loadavg").text()).trim();
  const cpuCount = cpus().length;
  const before = await swapCounters();
  const bytesPerPage = await pageSize();
  const abort = new AbortController();
  const violations: { kind: string; value: string }[] = [];

  const reject = (kind: string, value: string) => {
    if (violations.length < 20) violations.push({ kind, value });
    abort.abort();
  };

  const swap = new SwapGate(reject, process.env["CANOPY_BENCH_STAGE"] === "2");

  if (Number(loadavg.split(" ")[0]) > cpuCount) reject("load", loadavg);
  console.info(
    JSON.stringify({ phase: "host_begin", pair, attempt, loadavg, cpus: cpuCount, swap: before, bytesPerPage }),
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
        console.info(JSON.stringify({ phase: "host_sample", pair, attempt, loadavg: load, vmstat: line }));

        swap.sample(values[6]!, values[7]!);
        swap.cumulative(((await swapCounters()).output - before.output) * bytesPerPage);

        if (maxLoad > cpuCount) reject("load", load);
      }
    }

    if (!stopping) reject("monitor_exited", "vmstat exited before the pair completed");
  })();

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

      swap.cumulative((after.output - before.output) * bytesPerPage);
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
          violations,
        }),
      );

      return accepted;
    },
  };
}
