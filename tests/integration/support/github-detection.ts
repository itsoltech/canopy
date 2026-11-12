import { Schema } from "effect";
import { githubPrData, githubPrFixture } from "./github-pr.ts";

export function detectionPull(
  number: number,
  ref: string,
  sha: string,
  options: { state?: string; headId?: number; headName?: string; baseRef?: string } = {},
) {
  return {
    number,
    state: options.state ?? "open",
    merged_at: options.state === "merged" ? "2026-11-10T12:00:00Z" : null,
    head: { ref, sha, repo: { id: options.headId ?? 777, full_name: options.headName ?? "itsoltech/canopy" } },
    base: { ref: options.baseRef ?? "dev", repo: { id: 777, full_name: "itsoltech/canopy" } },
  };
}

export function githubDetectionFixture() {
  const fixture = githubPrFixture();
  const pulls = new Map<number, ReturnType<typeof detectionPull>>();
  const requests: string[] = [];
  let limited = false;
  let gate = Promise.resolve();
  fixture.intercept((request) => {
    const url = new URL(request.url);

    if (/^\/user\/installations\/[0-9]+\/repositories$/.test(url.pathname))
      return Response.json({
        total_count: 2,
        repositories: [
          { id: 777, full_name: "itsoltech/canopy", private: true, permissions: { pull: true, push: true } },
          { id: 888, full_name: "fork-owner/canopy", private: true, permissions: { pull: true, push: true } },
        ],
      });

    if (url.pathname === "/repos/fork-owner/canopy")
      return Response.json({
        id: 888,
        full_name: "fork-owner/canopy",
        parent: { id: 777, full_name: "itsoltech/canopy" },
      });

    if (url.pathname === "/repos/fork-owner/canopy/pulls") return Response.json([]);

    if (url.pathname === "/repos/itsoltech/canopy/pulls") {
      requests.push(url.search);

      return gate.then(() => {
        if (limited)
          return Response.json({ message: "secondary rate limit" }, { status: 429, headers: { "retry-after": "60" } });
        const target = url.searchParams.get("head");

        const matches = [...pulls.values()].filter(
          (p) => `${p.head.repo.full_name.split("/")[0]}:${p.head.ref}` === target,
        );

        const page = Number(url.searchParams.get("page") || 1);
        const next = page * 100 < matches.length;
        const nextUrl = new URL(`https://api.github.com${url.pathname}${url.search}`);
        nextUrl.searchParams.set("page", String(page + 1));

        return Response.json(matches.slice((page - 1) * 100, page * 100), {
          headers: next ? { link: `<${nextUrl}>; rel="next"` } : {},
        });
      });
    }

    const match = /^\/repos\/itsoltech\/canopy\/pulls\/(\d+)$/.exec(url.pathname);

    if (match) {
      const pull = pulls.get(Number(match[1]));

      return pull ? Response.json({ ...pull, merged: !!pull.merged_at }) : Response.json({}, { status: 404 });
    }

    return undefined;
  });
  fixture.pullRequest((number, state, draft) => {
    const pull = pulls.get(number);
    const data = githubPrData(number, pull ? (pull.merged_at ? "MERGED" : pull.state.toUpperCase()) : state, draft);

    return {
      ...data,
      headRefName: pull?.head.ref ?? data.headRefName,
      headRefOid: pull?.head.sha ?? data.headRefOid,
      baseRefName: pull?.base.ref ?? data.baseRefName,
      headRepository: {
        databaseId: pull?.head.repo.id ?? 777,
        nameWithOwner: pull?.head.repo.full_name ?? "itsoltech/canopy",
      },
    };
  });

  return {
    ...fixture,
    pulls,
    requests,
    limit: (value: boolean) => {
      limited = value;
    },
    wait: (value: Promise<void>) => {
      gate = value;
    },
  };
}

export const cursorNumbers = Schema.Record(Schema.String, Schema.Number);
