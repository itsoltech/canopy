/** Read kernel-thread CPU ticks, last CPU and zram I/O; affinity may require privileges. */
export async function kernelNoiseMonitor() {
  const child = Bun.spawn(["ps", "-e", "-o", "pid=,comm="], { stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();

  if (await child.exited) throw new Error("Cannot discover kernel noise threads");

  const threads = output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+((?:kswapd|zram)\S*)$/);

    return match ? [{ pid: Number(match[1]), name: match[2]! }] : [];
  });

  return async () => ({
    threads: await Promise.all(
      threads.map(async (thread) => {
        try {
          const stat = await Bun.file(`/proc/${thread.pid}/stat`).text();

          const fields = stat
            .slice(stat.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/);

          return { ...thread, userTicks: Number(fields[11]), systemTicks: Number(fields[12]), cpu: Number(fields[36]) };
        } catch {
          return { ...thread, unavailable: true };
        }
      }),
    ),
    zramIo: await Bun.file("/sys/block/zram0/stat")
      .text()
      .then(
        (value) => value.trim(),
        () => null,
      ),
  });
}
