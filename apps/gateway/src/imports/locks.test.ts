import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Lock order of the CLI import (locks.ts): row locks and transactions come only from importTransaction, so no import
 * code can lock rows in an order of its own and deadlock against another import transaction.
 */
test("import code takes row locks and transactions only through importTransaction", () => {
  const dir = import.meta.dir;
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "locks.ts");

  const offending = sources.filter((f) =>
    /FOR (?:NO KEY )?UPDATE|FOR (?:KEY )?SHARE|LOCK TABLE|withTransaction|pg_advisory/i.test(
      readFileSync(join(dir, f), "utf8"),
    ),
  );

  expect(sources.length).toBeGreaterThan(5);
  expect(offending).toEqual([]);
});
