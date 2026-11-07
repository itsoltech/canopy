/** Shared Actions API client. Uses gh's GH_TOKEN authentication without constructing credentialed URLs. */
import { execFileSync } from "node:child_process";
import type { JsonValue } from "@canopy/domain";

export function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// GitHub answers reads with occasional 502s or cut-off bodies. Reads retry; writes never do, because a failed
// write may still have happened (a second dispatch would start a second release).
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

const TRANSIENT = /HTTP 5\d\d|unexpected end of JSON|timed? ?out|ECONNRESET|connection reset|EOF/i;

function read<T>(run: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return run();
    } catch (error) {
      const text = error instanceof Error ? `${error.message}\n${"stderr" in error ? String(error.stderr) : ""}` : "";
      const reason = text.split("\n").find((line) => TRANSIENT.test(line));
      const delay = RETRY_DELAYS_MS[attempt];

      if (delay === undefined || reason === undefined) throw error;
      console.error(`GitHub read failed (${reason.trim()}); retrying in ${delay / 1000} s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

export function api(path: string, method = "GET", body?: JsonValue): JsonValue | undefined {
  const args = ["api", path, "--method", method];

  if (body !== undefined) args.push("--input", "-");

  const call = (): JsonValue | undefined => {
    const output = execFileSync("gh", args, {
      encoding: "utf8",
      ...(body !== undefined && { input: JSON.stringify(body) }),
    });

    return output ? JSON.parse(output) : undefined;
  };

  return method === "GET" ? read(call) : call();
}

export function pages(path: string): JsonValue[] {
  const result = read((): JsonValue =>
    JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8" })),
  );

  if (!Array.isArray(result) || !result.every(Array.isArray)) throw new Error("Invalid paginated GitHub response");

  return result.flat();
}

export function repository(): string {
  const value = process.env["GITHUB_REPOSITORY"];

  if (!value || !/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error("GITHUB_REPOSITORY is required");

  return value;
}

export function dispatchRelease(repo: string, branch: string, sha: string): void {
  api(`repos/${repo}/actions/workflows/release.yml/dispatches`, "POST", { ref: branch, inputs: { expected_sha: sha } });
}
