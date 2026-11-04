import { execFileSync } from "node:child_process";

export function buildVersion(): string {
  const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();

  return `${commit}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}
