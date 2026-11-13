/** Ignore old swapped pages; reject current pressure using explicit KiB/s and cumulative byte thresholds. */
export class SwapGate {
  peakInputKiB = 0;
  peakOutputKiB = 0;
  consecutiveInput = 0;
  longestInput = 0;

  constructor(readonly reject: (kind: string, value: string) => void) {}

  sample(inputKiB: number, outputKiB: number) {
    this.peakInputKiB = Math.max(this.peakInputKiB, inputKiB);
    this.peakOutputKiB = Math.max(this.peakOutputKiB, outputKiB);
    this.consecutiveInput = inputKiB >= 128 ? this.consecutiveInput + 1 : 0;
    this.longestInput = Math.max(this.longestInput, this.consecutiveInput);

    if (outputKiB >= 128) this.reject("swap_out_rate", String(outputKiB));

    if (inputKiB >= 1024) this.reject("swap_in_rate", String(inputKiB));

    if (this.consecutiveInput >= 3) this.reject("swap_in_sustained", String(this.consecutiveInput));
  }

  cumulative(outputBytes: number) {
    if (outputBytes >= 1024 * 1024) this.reject("swap_out_total_bytes", String(outputBytes));
  }
}

export async function swapCounters() {
  const counters = await Bun.file("/proc/vmstat").text();

  return {
    input: Number(counters.match(/^pswpin (\d+)/m)?.[1] ?? 0),
    output: Number(counters.match(/^pswpout (\d+)/m)?.[1] ?? 0),
  };
}

export async function pageSize() {
  const child = Bun.spawn(["getconf", "PAGESIZE"], { stdout: "pipe", stderr: "inherit" });
  const size = Number((await new Response(child.stdout).text()).trim());

  if ((await child.exited) !== 0 || !Number.isInteger(size) || size < 1024)
    throw new Error("Host page size unavailable");

  return size;
}
