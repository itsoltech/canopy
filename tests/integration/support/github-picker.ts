import { Schema } from "effect";
import { githubPrData, githubPrFixture } from "./github-pr.ts";

export function githubPickerFixture() {
  const fixture = githubPrFixture();
  let calls = 0;
  let notModified = 0;
  let status = 200;
  let empty = false;
  const requests: string[] = [];

  const pulls = Array.from({ length: 75 }, (_, i) => ({
    number: i + 1,
    title: `Pull request ${i + 1}: ${i === 17 ? "restore keyboard focus" : "update repository"}`,
    state: i === 68 || i === 69 ? "closed" : "open",
    draft: i === 44,
    merged_at: i === 68 ? "2026-11-10T12:00:00Z" : null,
    head: { ref: i === 41 || i === 44 ? "feat/picker" : i === 17 ? "fix/keyboard-focus" : `feat/change-${i}` },
    base: { ref: "dev", repo: { id: 777 } },
    user: { login: i % 5 === 0 ? "account-101" : `contributor-${i}` },
    updated_at: new Date(Date.UTC(2026, 10, 10, 12, -i)).toISOString(),
  }));

  fixture.intercept((request, user) => {
    const url = new URL(request.url);

    if (!["/repos/itsoltech/canopy/pulls", "/graphql"].includes(url.pathname)) return;

    return (async () => {
      const body =
        request.method === "POST"
          ? Schema.decodeUnknownSync(Schema.Struct({ query: Schema.String, variables: Schema.JsonObject }))(
              await request.json(),
            )
          : undefined;

      if (body && !body.query.includes("CanopyPicker"))
        return Response.json({
          data: {
            repository: { databaseId: 777, pullRequest: githubPrData(Number(body.variables["number"])) },
            rateLimit: {
              cost: 1,
              remaining: 4900,
              resetAt: new Date(fixture.options.now!() + 3_600_000).toISOString(),
            },
          },
        });
      calls++;
      requests.push(request.url);

      if (status !== 200)
        return Response.json(
          { message: "fixture denial" },
          {
            status,
            headers:
              status === 429 || status === 403
                ? {
                    "x-ratelimit-remaining": "0",
                    "x-ratelimit-reset": String(Math.floor(fixture.options.now!() / 1000) + 120),
                  }
                : {},
          },
        );

      const all = body
        ? body.query.includes("CanopyPickerBranch")
          ? body.query.includes("CLOSED")
          : String(body.variables["q"]).includes("is:open") === false
        : url.searchParams.get("state") === "all";

      let rows = (empty ? [] : pulls).filter((pr) => all || pr.state === "open");

      if (body) {
        rows = body.query.includes("CanopyPickerBranch")
          ? rows.filter((pr) => pr.head.ref === body.variables["branch"])
          : rows.filter((pr) => pr.user.login === `account-${user}`);
      }

      const offset = body
        ? Number(body.variables["after"] || 0)
        : (Number(url.searchParams.get("page") || "1") - 1) * 30;
      const page = rows.slice(offset, offset + 30);
      const next = offset + page.length < rows.length;

      if (body) {
        const result = {
          pageInfo: { hasNextPage: next, endCursor: next ? String(offset + 30) : null },
          nodes: page.map((pr) => ({
            number: pr.number,
            title: pr.title,
            state: pr.merged_at ? "MERGED" : pr.state.toUpperCase(),
            isDraft: pr.draft,
            headRefName: pr.head.ref,
            baseRefName: pr.base.ref,
            updatedAt: pr.updated_at,
            author: pr.user,
            repository: { databaseId: 777 },
          })),
        };

        return Response.json({
          data: {
            ...(body.query.includes("CanopyPickerBranch")
              ? { repository: { databaseId: 777, pulls: result } }
              : { search: result }),
            rateLimit: {
              cost: 1,
              remaining: 4900,
              resetAt: new Date(fixture.options.now!() + 3_600_000).toISOString(),
            },
          },
        });
      }

      const headers = {
        etag: `"picker-${url.search}"`,
        ...(next && {
          link: `<https://api.github.com/repos/itsoltech/canopy/pulls?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), page: String(offset / 30 + 2) })}>; rel="next"`,
        }),
      };

      if (request.headers.get("if-none-match") === headers.etag) {
        notModified++;

        return new Response(null, { status: 304, headers });
      }

      return Response.json(page, { headers });
    })();
  });

  return {
    ...fixture,
    requests,
    get pickerCalls() {
      return calls;
    },
    get pickerNotModified() {
      return notModified;
    },
    pickerStatus: (value: number) => {
      status = value;
    },
    empty: (value: boolean) => {
      empty = value;
    },
  };
}
