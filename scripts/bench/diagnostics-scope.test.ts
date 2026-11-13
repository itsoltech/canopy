import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkScopes } from "./diagnostics-scope.ts";

test("scope gates require zero swap in both groups and fail closed when a limit or counter is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canopy-diagnostics-scope-"));
  const scopes = [join(directory, "gateway-worker"), join(directory, "postgres")];
  const rejected: string[] = [];
  const reject = (kind: string) => rejected.push(kind);

  try {
    for (const scope of scopes) {
      await mkdir(scope);
      await writeFile(join(scope, "memory.swap.max"), "0\n");
      await writeFile(join(scope, "memory.swap.current"), "0\n");
    }

    expect(await checkScopes(scopes, reject)).toHaveLength(2);
    expect(rejected).toEqual([]);

    for (const scope of scopes) {
      await writeFile(join(scope, "memory.swap.current"), "1\n");
      await checkScopes(scopes, reject);
      expect(rejected.splice(0)).toEqual(["scope_swap_current"]);
      await writeFile(join(scope, "memory.swap.current"), "0\n");
    }

    await writeFile(join(scopes[1]!, "memory.swap.max"), "max\n");
    expect(await checkScopes(scopes, reject)).toEqual([]);
    expect(rejected.splice(0)).toEqual(["scope_swap_unavailable"]);
    await writeFile(join(scopes[1]!, "memory.swap.max"), "0\n");
    await unlink(join(scopes[0]!, "memory.swap.current"));
    expect(await checkScopes(scopes, reject)).toEqual([]);
    expect(rejected).toEqual(["scope_swap_unavailable"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
