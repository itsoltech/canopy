import type { ChildProcess } from "node:child_process";
import { until } from "./process.ts";

/** PostgreSQL reports this before opening its SQL listener, even when --version succeeds. */
export async function databaseReady(child: ChildProcess, check: () => Promise<boolean>, timeout = 60_000) {
  let output = "";

  const receive = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-2048);
  };

  child.stderr?.on("data", receive);

  try {
    await until(
      check,
      timeout,
      () => true,
      () =>
        /Execution of PostgreSQL by a user with administrative permissions is not\s+permitted\./.test(output)
          ? new Error(
              "The local database cannot run with administrator rights. Close Canopy and open it without “Run as administrator”.",
            )
          : undefined,
    );
  } finally {
    child.stderr?.off("data", receive);
  }
}
