import { describe, expect, test } from "bun:test";
import { ISSUE_MENTION_LIMITS, type JsonValue } from "@canopy/domain";
import { searchProviderIssues, type IssueToolCall } from "./issue-providers.ts";

const jsonText = (value: JsonValue) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const linearUrl = "https://linear.app/team/issue/ENG-42/fix-filter";
const alphaCloud = "a1234567-0000-4000-8000-000000000000";
const betaCloud = "b1234567-0000-4000-8000-000000000000";
const githubUrl = "https://github.com/sample/web/issues/42";
const gh = { number: 42, html_url: githubUrl, title: "Fix filtering", state: "open", body: "Apply filters on reload." };

describe("issue provider reads", () => {
  test("Linear accepts human ids in lists and identifiers in single issue records", async () => {
    const found = await searchProviderIssues(
      "linear",
      "filter",
      async (tool, args) => {
        expect([tool, args]).toEqual(["list_issues", { query: "filter", limit: 3 }]);

        return jsonText({
          issues: [
            {
              id: "ENG-42",
              uuid: "11111111-2222-4333-8444-555555555555",
              title: "  Fix\nfiltering  ",
              description: "😀".repeat(2500),
              url: linearUrl,
              state: { name: " In\tProgress " },
            },
            { id: "ENG-9", title: "Invalid link", url: "https://linear.app/w/issue/ENG-9?signature=private" },
            { id: "invalid key\n", title: "Malformed key", url: linearUrl },
          ],
          hasNextPage: true,
          cursor: "opaque",
        });
      },
      { limit: 3 },
    );

    expect(found).toEqual([
      {
        key: "ENG-42",
        title: "Fix filtering",
        url: linearUrl,
        status: "In Progress",
        description: "😀".repeat(ISSUE_MENTION_LIMITS.description / 2),
      },
    ]);

    const read: IssueToolCall = async (tool, args) => {
      expect([tool, args]).toEqual(["get_issue", { id: "ENG-42" }]);

      return {
        content: [],
        structuredContent: {
          issue: {
            id: "11111111-2222-4333-8444-555555555555",
            identifier: "ENG-42",
            title: "Fix",
            url: linearUrl,
            description: "Steps\n1. Reload",
            status: "Backlog",
          },
        },
      };
    };

    const exact = await searchProviderIssues("linear", "eng-42", read);
    expect((await searchProviderIssues("linear", linearUrl, read))[0]?.url).toBe(linearUrl);
    expect(await searchProviderIssues("linear", "https://linear.app/elsewhere/issue/ENG-42", read)).toEqual([]);

    expect(exact[0]).toMatchObject({ key: "ENG-42", description: "Steps\n1. Reload", status: "Backlog" });
  });

  test("GitHub search takes issue links and bodies from REST rows and excludes PRs, bad links and other repositories", async () => {
    const hits = await searchProviderIssues(
      "github",
      'filter" repo:other/repo',
      async (tool, args) => {
        expect([tool, args]).toEqual([
          "search_issues",
          { query: 'is:issue "filter repo other repo" in:title,body', perPage: 8, owner: "sample", repo: "web" },
        ]);

        return jsonText({
          total_count: 5,
          incomplete_results: false,
          items: [
            gh,
            { ...gh, pull_request: { url: "https://api.github.com/repos/sample/web/pulls/42" } },
            { ...gh, html_url: "https://github.com/other/web/issues/42" },
            { ...gh, html_url: "https://user:pass@github.com/sample/web/issues/42" },
            { ...gh, html_url: "https://github.com/sample/web/issues/9" },
          ],
        });
      },
      { limit: 8, repository: "sample/web" },
    );

    expect(hits).toEqual([
      { key: "sample/web#42", title: gh.title, url: githubUrl, status: "open", description: gh.body },
    ]);
  });

  test("GitHub resolves qualified and workspace issue numbers and checks the link returned for an exact lookup", async () => {
    const read: IssueToolCall = async (tool, args) => {
      expect([tool, args]).toEqual(["issue_read", { method: "get", owner: "sample", repo: "web", issue_number: 42 }]);

      return { content: [], structuredContent: { method: "get", issue: gh } };
    };

    for (const query of ["sample/web#42", githubUrl, "#42", "42"])
      expect((await searchProviderIssues("github", query, read, { repository: "sample/web" }))[0]?.key).toBe(
        "sample/web#42",
      );

    expect(await searchProviderIssues("github", "https://other.example/sample/web/issues/42", read)).toEqual([]);

    const unscoped = await searchProviderIssues("github", "#42", async (tool, args) => {
      expect([tool, args["query"]]).toEqual(["search_issues", "is:issue 42"]);

      return jsonText({ items: [gh, { ...gh, number: 43, html_url: "https://github.com/sample/web/issues/43" }] });
    });

    expect(unscoped.map((i) => i.key)).toEqual(["sample/web#42"]);
  });

  test("Jira searches discovered Jira clouds once each and decodes nested nodes, ADF and REST text", async () => {
    const sites: string[] = [];
    const wiki = { id: alphaCloud, url: "https://alpha.atlassian.net", scopes: ["read:confluence-content.all"] };
    const first = { ...wiki, scopes: ["read:jira-work"] };
    const last = { id: betaCloud, url: "https://beta.atlassian.net", scopes: ["read:issue:jira"] };

    const hits = await searchProviderIssues(
      "atlassian",
      "fix",
      async (tool, args) => {
        if (tool === "getAccessibleAtlassianResources") return jsonText([wiki, first, first, last]);
        expect(tool).toBe("searchJiraIssuesUsingJql");
        expect(args).toMatchObject({
          fields: ["summary", "description", "status"],
          maxResults: 5,
          jql: 'text ~ "\\"fix\\"" ORDER BY updated DESC',
        });
        sites.push(String(args["cloudId"]));

        const fields = {
          summary: "Filter reload",
          status: { name: "In review", statusCategory: { id: 4 } },
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Retain " },
                  { type: "text", text: "filters", marks: [{ type: "strong" }] },
                ],
              },
              { type: "paragraph", content: [{ type: "text", text: "on reload." }] },
            ],
          },
        };

        if (args["cloudId"] === alphaCloud) return jsonText({ issues: [{ key: "WEB-12", fields }], isLast: true });

        return {
          content: [],
          structuredContent: {
            issues: {
              nodes: [{ key: "WEB-12", fields: { ...fields, description: "Second tenant's issue." } }],
              totalCount: 1,
              pageInfo: { hasNextPage: false },
            },
          },
        };
      },
      { limit: 5 },
    );

    expect(sites).toEqual([alphaCloud, betaCloud]);
    expect(hits).toEqual([
      {
        key: "WEB-12",
        title: "Filter reload",
        status: "In review",
        url: "https://alpha.atlassian.net/browse/WEB-12",
        description: "Retain filters\non reload.",
      },
      {
        key: "WEB-12",
        title: "Filter reload",
        status: "In review",
        url: "https://beta.atlassian.net/browse/WEB-12",
        description: "Second tenant's issue.",
      },
    ]);
  });

  test("Jira selects a pasted site only from discovery and keeps JQL text inside its quoted phrase", async () => {
    const resources = {
      data: {
        resources: [
          {
            cloudId: alphaCloud,
            url: "https://docs.atlassian.net",
            products: [{ id: "confluence", access: "read-only" }],
          },
          { cloudId: betaCloud, url: "https://teams.atlassian.net", products: [{ id: "jira", access: "read-only" }] },
        ],
      },
    };

    const jql: string[] = [];

    const run: IssueToolCall = async (tool, args) => {
      if (tool === "getAccessibleAtlassianResources") return jsonText(resources);
      expect([tool, args["cloudId"]]).toEqual(["searchJiraIssuesUsingJql", betaCloud]);
      jql.push(String(args["jql"]));

      return jsonText({ data: { issues: [{ key: "OPS-113", fields: { summary: "Reload" } }] } });
    };

    expect((await searchProviderIssues("atlassian", "https://teams.atlassian.net/browse/OPS-113", run))[0]?.key).toBe(
      "OPS-113",
    );
    expect(await searchProviderIssues("atlassian", "https://unknown.atlassian.net/browse/OPS-113", run)).toEqual([]);
    await searchProviderIssues("atlassian", 'xx" OR project = "Private', run);
    expect(jql).toEqual([
      'key = "OPS-113"',
      "text ~ " + JSON.stringify('"xx\\" OR project = \\"Private"') + " ORDER BY updated DESC",
    ]);
  });

  test("MCP failures and unexpected payloads fail the read without exposing remote response text", async () => {
    const sensitive = "private remote error";
    await expect(
      searchProviderIssues("linear", "filter", async () => ({ ...jsonText(sensitive), isError: true })),
    ).rejects.toThrow("Issue provider read failed");
    await expect(searchProviderIssues("linear", "filter", async () => jsonText({ error: sensitive }))).rejects.toThrow(
      "Invalid Linear issue list",
    );
    let called = false;

    await expect(
      searchProviderIssues("custom", "filter", async () => {
        called = true;

        return jsonText([]);
      }),
    ).rejects.toThrow("Unsupported issue provider");
    expect(called).toBe(false);
  });
});

describe("GitHub issue and pull request mentions", () => {
  const repository = "sample/web";
  const pullUrl = "https://github.com/sample/web/pull/97";

  const pull = {
    number: 97,
    title: "Restore filters on reload",
    body: "Keep the selected filters when the URL changes.",
    state: "closed",
    html_url: pullUrl,
  };

  const searchPull = {
    ...pull,
    pull_request: {
      url: "https://api.github.com/repos/sample/web/pulls/97",
      html_url: pullUrl,
      merged_at: "2026-11-20T11:25:00Z",
    },
  };

  const readPull = { ...pull, draft: false, merged: true, head: { ref: "restore-filters" }, base: { ref: "dev" } };

  test("keyword results interleave both GitHub search pages, validate their kind and keep pull request metadata", async () => {
    const hits = await searchProviderIssues(
      "github",
      "filters",
      async (tool, args) => {
        expect(args).toMatchObject({ owner: "sample", repo: "web", perPage: 2 });

        if (tool === "search_pull_requests") {
          expect(args["query"]).toBe('is:pr "filters" in:title,body');

          return jsonText({ total_count: 2, items: [gh, searchPull] });
        }

        expect(tool).toBe("search_issues");
        expect(args["query"]).toBe('is:issue "filters" in:title,body');

        return {
          content: [],
          structuredContent: {
            items: [searchPull, gh, { ...gh, number: 45, html_url: "https://github.com/sample/web/issues/45" }],
          },
        };
      },
      { repository, limit: 2, includePullRequests: true },
    );

    expect(hits).toEqual([
      { key: "sample/web#42", title: gh.title, url: githubUrl, status: "open", description: gh.body },
      {
        key: "sample/web#97",
        title: pull.title,
        url: pullUrl,
        status: "merged",
        description: pull.body,
        pullRequest: true,
      },
    ]);
  });

  test("numbers and pull links use read-only exact reads, including when only one kind is accessible", async () => {
    const warnings: string[] = [];
    const options = { repository, includePullRequests: true, onPartialFailure: (kind: string) => warnings.push(kind) };
    const missing = { isError: true, content: [{ type: "text" as const, text: "failed to get issue: 404 Not Found" }] };

    const read: IssueToolCall = async (tool, args) => {
      if (tool === "issue_read") {
        expect(args).toEqual({ owner: "sample", repo: "web", method: "get", issue_number: 97 });

        return missing;
      }

      expect([tool, args]).toEqual([
        "pull_request_read",
        { owner: "sample", repo: "web", method: "get", pullNumber: 97 },
      ]);

      return { content: [], structuredContent: readPull };
    };

    for (const query of ["97", "#97", "sample/web#97"])
      expect((await searchProviderIssues("github", query, read, options))[0]).toMatchObject({
        url: pullUrl,
        description: pull.body,
        pullRequest: true,
      });

    const calls: string[] = [];

    const fromUrl: IssueToolCall = async (tool) => {
      calls.push(tool);

      return jsonText(readPull);
    };

    expect(await searchProviderIssues("github", pullUrl, fromUrl)).toEqual([]);
    expect((await searchProviderIssues("github", pullUrl, fromUrl, options))[0]?.key).toBe("sample/web#97");
    expect(
      await searchProviderIssues("github", "https://elsewhere.example/sample/web/pull/97", fromUrl, options),
    ).toEqual([]);
    expect(calls).toEqual(["pull_request_read", "pull_request_read"]);

    const exactIssue = await searchProviderIssues(
      "github",
      "42",
      async (tool) => {
        if (tool === "pull_request_read") throw new Error("Tool unavailable");

        return jsonText(gh);
      },
      options,
    );

    expect(exactIssue[0]?.key).toBe("sample/web#42");
    expect(warnings).toEqual([]);
  });

  test("unscoped numbers filter both result pages, and genuine partial and total failures reach the caller", async () => {
    const warnings: string[] = [];
    const options = { includePullRequests: true, onPartialFailure: (kind: string) => warnings.push(kind) };

    const pulls = await searchProviderIssues(
      "github",
      "97",
      async (tool, args) => {
        if (tool === "search_issues") throw new Error("Tool unavailable");
        expect([tool, args["query"]]).toEqual(["search_pull_requests", "is:pr 97"]);

        return jsonText({
          items: [{ ...searchPull, number: 98, html_url: "https://github.com/sample/web/pull/98" }, searchPull],
        });
      },
      options,
    );

    expect(pulls.map((match) => match.key)).toEqual(["sample/web#97"]);
    expect(warnings).toEqual(["issues"]);

    const issues = await searchProviderIssues(
      "github",
      "filter",
      async (tool) => {
        if (tool === "search_pull_requests") return { isError: true, ...jsonText("private provider error") };

        return jsonText({ items: [gh] });
      },
      options,
    );

    expect(issues.map((match) => match.key)).toEqual(["sample/web#42"]);
    expect(warnings).toEqual(["issues", "pull requests"]);
    await expect(
      searchProviderIssues(
        "github",
        "filter",
        async () => {
          throw new Error("private");
        },
        options,
      ),
    ).rejects.toThrow("GitHub search failed");
  });
});
