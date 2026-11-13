/** Scope paths come from procfs, never a caller-supplied filesystem path. */
export async function userScope(pid = process.pid) {
  const membership = await Bun.file(`/proc/${pid}/cgroup`).text();
  const path = membership.match(/^0::(\/user\.slice\/[^\n]+\/canopy-diagnostics-[^/\n]+\.scope)$/m)?.[1];

  if (!path || path.split("/").includes("..")) throw new Error("Measured process is outside a benchmark user scope");

  return `/sys/fs/cgroup${path}`;
}

export async function scopeSample(scope: string) {
  const [max, current] = await Promise.all([
    Bun.file(`${scope}/memory.swap.max`).text(),
    Bun.file(`${scope}/memory.swap.current`).text(),
  ]);

  if (max.trim() !== "0" || !/^\d+\s*$/.test(current)) throw new Error("Benchmark scope swap limit unavailable");

  return { scope, swapMax: 0, swapCurrent: Number(current.trim()) };
}

export async function assertSameScope(pid: number) {
  if ((await userScope(pid)) !== (await userScope())) throw new Error("Measured child escaped the benchmark scope");
}

export const swapDisabledStage = () => ["2", "3"].includes(process.env["CANOPY_BENCH_STAGE"] ?? "");

export async function monitorScopes(postgresScope: string | undefined, reject: (kind: string, value: string) => void) {
  const scopes: string[] = [];

  if (swapDisabledStage()) {
    scopes.push(await userScope());

    if (!postgresScope) throw new Error("PostgreSQL must run in a swap-disabled user scope");
    scopes.push(postgresScope);
  }

  return () => checkScopes(scopes, reject);
}

export async function checkScopes(scopes: readonly string[], reject: (kind: string, value: string) => void) {
  try {
    const values = await Promise.all(scopes.map(scopeSample));

    for (const value of values)
      if (value.swapCurrent !== 0) reject("scope_swap_current", `${value.scope}: ${value.swapCurrent}`);

    return values;
  } catch {
    reject("scope_swap_unavailable", "Cannot verify zero swap and MemorySwapMax=0 for every measured scope");

    return [];
  }
}
