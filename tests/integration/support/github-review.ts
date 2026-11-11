import { mutationFixture, fixturePath } from "./github-mutations.ts";
import { readBase } from "./github-read.ts";
import { ReviewGraph } from "./github-review-graph.ts";

export const reviewPatch =
  "@@ -8,5 +8,5 @@\n before\n-old one\n-old two\n+new one\n+new two\n after\n end\n@@ -30 +30 @@\n-old far\n+new far";

/** Stateful upstream with private pending reviews shared across devices, but never accounts. */
export function reviewFixture() {
  const state = new ReviewGraph();

  const fixture = mutationFixture({
    graph: (query, variables, user) => state.graph(query, variables, user),
    rest: (request, user) => {
      const pending = state.rest(request, user);

      if (pending) return pending;

      if (new URL(request.url).pathname.endsWith("/pulls/42/files"))
        return Response.json([
          {
            filename: fixturePath(0),
            status: "modified",
            additions: 3,
            deletions: 3,
            patch: reviewPatch,
            blob_url: "https://github.com/itsoltech/canopy/pull/42/files",
          },
        ]);

      return;
    },
  });

  return {
    ...fixture,
    reviews: state.reviews,
    threads: state.threads,
    seed: (user: number, count?: number, pull?: string) => state.seed(user, count, pull),
    head: (value: string) => {
      state.head = value;
      fixture.head(value);
    },
    author: (value: number) => {
      state.author = value;
    },
    allowed: (value: boolean) => {
      state.permitted = value;
      fixture.allowed(value);
    },
    reject: (value: boolean) => {
      state.rejected = value;
      fixture.reject(value);
    },
    resolveAllowed: (value: boolean) => {
      state.canResolve = value;
    },
    beforeMutation: (value: () => void) => {
      state.beforeSend = value;
      fixture.beforeMutation(value);
    },
    get writes() {
      return state.mutations + fixture.writes;
    },
    baseSha: readBase,
  };
}
