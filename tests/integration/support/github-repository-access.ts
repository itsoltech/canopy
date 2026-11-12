import { githubPrFixture } from "./github-pr.ts";

/** Mutable installation intersection, served only through the existing loopback GitHub fixture. */
export function repositoryAccessFixture() {
  const fixture = githubPrFixture();
  const access = new Map<number, string[]>([[101, ["itsoltech/canopy"]]]);
  const calls: { user: number; path: string }[] = [];
  fixture.intercept((request, user) => {
    const url = new URL(request.url);
    calls.push({ user, path: url.pathname });

    if (url.pathname === "/user/installations")
      return Response.json({
        total_count: 1,
        installations: [
          {
            id: user,
            account: { login: "itsoltech", type: "Organization" },
            repository_selection: "selected",
            permissions: { contents: "write", pull_requests: "write" },
            suspended_at: null,
          },
        ],
      });

    if (/^\/user\/installations\/[0-9]+\/repositories$/.test(url.pathname)) {
      const repositories = (access.get(user) ?? []).map((name) => ({
        id: name === "itsoltech/canopy" ? 777 : 888,
        full_name: name,
        private: true,
        permissions: { pull: true, push: true },
      }));

      return Response.json({ total_count: repositories.length, repositories });
    }

    return undefined;
  });

  return {
    ...fixture,
    requests: calls,
    access: (user: number, names: string[]) => access.set(user, names),
  };
}
