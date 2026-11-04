/** Shared Actions API client. Uses gh's GH_TOKEN authentication without constructing credentialed URLs. */
import { execFileSync } from "node:child_process";
import type { JsonValue } from "@canopy/domain";

export function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function api(path: string, method = "GET", body?: JsonValue): JsonValue | undefined {
  const args = ["api", path, "--method", method];

  if (body !== undefined) args.push("--input", "-");

  const output = execFileSync("gh", args, {
    encoding: "utf8",
    ...(body !== undefined && { input: JSON.stringify(body) }),
  });

  return output ? JSON.parse(output) : undefined;
}

export function pages(path: string): JsonValue[] {
  const output = execFileSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8" });

  const result: JsonValue = JSON.parse(output);

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
