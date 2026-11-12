/** Isolated JS-only ABBA probes reuse #413–#419's real reducers, feed builders and cache. */
for (const [member, on] of [
  ["A1", false],
  ["B1", true],
  ["B2", true],
  ["A2", false],
] as const) {
  const child = Bun.spawn([process.execPath, "scripts/bench/client-js.ts"], {
    env: { ...process.env, CANOPY_BENCH_CLIENT_DIAGNOSTICS: on ? "1" : "0", CANOPY_BENCH_MEMBER: member },
    stdout: "inherit",
    stderr: "inherit",
  });

  if (await child.exited) throw new Error(`Client JS probe ${member} failed`);
}
