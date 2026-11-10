import { cpus } from "node:os";

export function pinnedCommand(env: Record<string, string | undefined>, role: "GATEWAY" | "WORKER", args: string[]) {
  const cpu = env[`CANOPY_BENCH_${role}_CPU`];

  if (!cpu) return args;

  if (!/^\d+$/.test(cpu)) throw new Error("Choose one CPU per benchmark process");

  return ["taskset", "-c", cpu, ...args];
}

async function swapCounters() {
  const counters = await Bun.file("/proc/vmstat").text();

  return {
    input: Number(counters.match(/^pswpin (\d+)/m)?.[1] ?? 0),
    output: Number(counters.match(/^pswpout (\d+)/m)?.[1] ?? 0),
  };
}

/** vmstat's first data row is since boot; subsequent rows describe the measured second. */
export async function monitorHost(pair: number, attempt: number) {
  const loadavg = (await Bun.file("/proc/loadavg").text()).trim();
  const cpuCount = cpus().length;
  const before = await swapCounters();
  const abort = new AbortController();
  const violations: { kind: string; value: string }[] = [];

  const reject = (kind: string, value: string) => {
    if (violations.length < 20) violations.push({ kind, value });
    abort.abort();
  };

  if (Number(loadavg.split(" ")[0]) > cpuCount) reject("load", loadavg);
  console.info(JSON.stringify({ phase: "host_begin", pair, attempt, loadavg, cpus: cpuCount, swap: before }));
  const vmstat = Bun.spawn(["vmstat", "-w", "1"], { stdout: "pipe", stderr: "inherit" });
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
        const load = (await Bun.file("/proc/loadavg").text()).trim();
        maxLoad = Math.max(maxLoad, Number(load.split(" ")[0]));
        console.info(JSON.stringify({ phase: "host_sample", pair, attempt, loadavg: load, vmstat: line }));

        if (values[6] || values[7]) reject("swap", line);

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

      if (after.input !== before.input || after.output !== before.output)
        reject("swap_pages", `${after.input - before.input}/${after.output - before.output}`);
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
          violations,
        }),
      );

      return accepted;
    },
  };
}
