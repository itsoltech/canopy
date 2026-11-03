/** Shared Actions API client. Uses gh's GH_TOKEN authentication without constructing credentialed URLs. */
import { execFileSync } from "node:child_process";

export function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
export function api<T>(path: string, method = "GET", body?: unknown): T {
  const args = ["api", path, "--method", method];
  if (body !== undefined) args.push("--input", "-");
  const output = execFileSync("gh", args, { encoding: "utf8", ...(body !== undefined ? { input: JSON.stringify(body) } : {}) });
  return output ? JSON.parse(output) as T : undefined as T;
}
export function pages<T>(path: string): T[] {
  const output = execFileSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8" });
  return (JSON.parse(output) as T[][]).flat();
}
export function repository(): string {
  const value = process.env["GITHUB_REPOSITORY"];
  if (!value || !/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error("GITHUB_REPOSITORY is required");
  return value;
}
export function dispatchRelease(repo: string, branch: string, sha: string): void {
  api(`repos/${repo}/actions/workflows/release.yml/dispatches`, "POST", { ref: branch, inputs: { expected_sha: sha } });
}
