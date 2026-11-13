import { expect, test } from "bun:test";
import type { JsonValue } from "@canopy/domain/json";
import { loadPromotion, type PromotionAdapters } from "./promotion-data.ts";
import { DAY, selectPromotion } from "./promotion-policy.ts";

test("a 555-commit range keeps paginated exact-commit gates within the API budget", () => {
  const history = Array.from({ length: 555 }, (_, i) => (i + 1).toString(16).padStart(40, "0"));
  const target = "0".repeat(40);
  const now = Date.parse("2026-11-13T12:00:00Z");

  const runs: JsonValue[] = history.map((sha, i) => ({
    id: i + 1,
    head_sha: sha,
    head_branch: "dev",
    status: "completed",
    conclusion: "success",
    run_number: i + 1,
    run_attempt: 1,
  }));

  // An older green run cannot override a newer failed attempt. Other branches cannot prove dev readiness.
  runs.push({
    id: 555,
    head_sha: history[554]!,
    head_branch: "dev",
    status: "completed",
    conclusion: "failure",
    run_number: 555,
    run_attempt: 2,
  });
  runs.push({
    id: 999,
    head_sha: history[554]!,
    head_branch: "next",
    status: "completed",
    conclusion: "success",
    run_number: 999,
    run_attempt: 1,
  });
  // More than 1,000 runs: branch-filtered GitHub searches would silently truncate this evidence.
  runs.unshift(
    ...Array.from({ length: 600 }, (_, i) => ({
      id: 1000 + i,
      head_sha: "unrelated",
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      run_number: 1000 + i,
      run_attempt: 1,
    })),
  );
  let reads = 0;
  const smokeRuns: string[] = [];

  const adapters: PromotionAdapters = {
    git(...args) {
      if (args[0] === "merge-base") return target;

      if (args[0] === "rev-list") return history.join("\n");

      if (args[0] === "diff-tree") return "feature.ts";

      if (args[0] === "rev-parse") {
        if (args[1] === "origin/dev") return history.at(-1)!;

        if (args[1] === "origin/next") return target;

        return target;
      }

      if (args.includes("--format=%ct")) return String((now - 2 * DAY) / 1000);

      if (args.includes("--format=%B")) return "feat: feature";
      throw new Error(`Unexpected git read: ${args.join(" ")}`);
    },
    api(path, method = "GET") {
      expect(method).toBe("GET");
      reads++;
      const url = new URL(`https://fixture.invalid/${path}`);
      const page = Number(url.searchParams.get("page"));

      if (path.includes("/workflows/")) {
        expect(url.searchParams.has("branch")).toBe(false);

        return { workflow_runs: runs.slice((page - 1) * 100, page * 100) };
      }

      smokeRuns.push(path);

      return {
        jobs: ["linux-x64", "linux-arm64", "darwin-arm64", "windows-x64"].map((platform) => ({
          name: `smoke (${platform}, fixture)`,
          conclusion: "success",
        })),
      };
    },
    pages(path) {
      reads++;

      if (path.includes("/pulls?"))
        return [
          {
            number: 68,
            merged_at: "2026-11-01",
            merge_commit_sha: history[0]!,
            base: { ref: "dev" },
            body: "",
            labels: [],
          },
        ];

      if (path.includes("/releases?") || path.includes("/issues?")) return [];
      throw new Error(`Unexpected GitHub read: ${path}`);
    },
  };

  const input = loadPromotion("fixture/canopy", "dev-next", DAY, adapters, now);
  expect(selectPromotion(input).sha).toBe(history[553]!);
  expect(selectPromotion(input).sha).toBe(history[553]!);
  expect(input.commits[0]!.prs[0]!.number).toBe(68);
  expect(smokeRuns).toHaveLength(1);
  expect(smokeRuns[0]).toContain("/runs/554/jobs?");
  expect(reads).toBeLessThan(20);
});
