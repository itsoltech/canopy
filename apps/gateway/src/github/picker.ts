import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GitHubPullRequests } from "./pull-requests.ts";
import { githubName } from "./discovery.ts";
import { GitHubHttpFailure, githubFailure } from "./http.ts";
import { uuid } from "./records.ts";
import { digest, invalidCursor } from "./read-scope.ts";
import { pickerCursor } from "./picker-cursor.ts";
import { pickerPage, type PickerSource } from "./picker-page.ts";
import { pickerFailure } from "./picker-state.ts";

/** Thread ownership is verified before resolving accounts, looking up cache or contacting GitHub. */
export async function repositoryPullRequests(prs: GitHubPullRequests, r: github.RepositoryPullRequestsRequest) {
  if (!uuid(r.threadId)) throw new ConnectError("Thread not found", Code.NotFound);
  const { accounts } = prs;
  const thread = (await accounts.run((s) => s.prPickerContext(accounts.owner, r.threadId)))[0];

  if (!thread) throw new ConnectError("Thread not found", Code.NotFound);
  const config = accounts.http.config;
  const response = create(github.RepositoryPullRequestsResponseSchema, {
    repositoryName: githubName(thread.git_origin),
    configured: config.configured,
    installUrl: config.configured ? `https://github.com/apps/${config.slug}/installations/new` : "",
  });

  if (!response.repositoryName) {
    response.state = "not_github";
    response.detail = "This workspace has no GitHub remote. Paste a pull request URL to link it.";

    return response;
  }

  if (r.query.length > 200) throw new ConnectError("Use at most 200 characters to search.", Code.InvalidArgument);

  try {
    const selection = await prs.repositories.get(response.repositoryName);
    // Prefer an App account with verified installation access over a PAT fallback.
    selection.candidates.sort(
      (a, b) =>
        Number(b.authKind === "device") - Number(a.authKind === "device") ||
        a.login.localeCompare(b.login) ||
        a.id.localeCompare(b.id),
    );
    response.selection = selection;

    if (!selection.accountId || !selection.candidates.some((a) => a.id === selection.accountId)) {
      const available = await accounts.list();
      response.configured = available.configured;
      response.installUrl = available.installUrl;
      response.state = selection.candidates.length
        ? "choose_account"
        : available.accounts.some((a) => a.status === "connected")
          ? "installation_required"
          : "account_required";
      if (response.state === "choose_account") response.detail = "Choose an account to load pull requests.";
      else if (response.state === "installation_required")
        response.detail =
          "This repository is not available to your connected accounts. Manage repository access on GitHub.";
      else response.detail = "Connect GitHub to browse pull requests.";

      return response;
    }

    const selected = await prs.repositories.selected(response.repositoryName);
    const access = await accounts.access.token(selected.row.id);
    const source: PickerSource = {
      account: selected.row.id,
      repository: response.repositoryName,
      repositoryId: selected.mapping.repository_id,
      branch: thread.branch,
      login: selected.row.login,
      all: r.includeClosed,
    };
    const binding = digest(
      JSON.stringify([
        accounts.owner,
        r.threadId,
        source,
        String(selected.row.revision),
        String(selected.mapping.revision),
        r.query.trim().toLowerCase(),
      ]),
    );
    const cursor = pickerCursor(access.token, binding, accounts.http.now(), r.cursor);
    let { lane, position, offset } = cursor;
    const linked = await prs.list(r.threadId);
    const words = r.query.trim().replace(/^#/, "").toLowerCase().split(/\s+/).filter(Boolean);
    const number = /^#?[1-9][0-9]*$/.test(r.query.trim()) ? Number(r.query.trim().replace(/^#/, "")) : 0;

    // Read at most 3 upstream pages per call. Sparse searches continue on the next scroll.
    for (let reads = 0; reads < 3 && lane < 3 && response.items.length < 30; reads++) {
      const page = await pickerPage(prs, source, lane, position);

      for (; offset < page.items.length && response.items.length < 30; offset++) {
        const pr = page.items[offset]!;
        pr.currentBranch = !!source.branch && pr.headRef === source.branch;
        pr.viewerIsAuthor = pr.author.toLowerCase() === source.login.toLowerCase();
        pr.linked = linked.links.some(
          (l) =>
            l.summary?.ref?.repositoryName.toLowerCase() === source.repository && l.summary.ref.number === pr.number,
        );

        if ((lane === 1 && pr.currentBranch) || (lane === 2 && (pr.currentBranch || pr.viewerIsAuthor))) continue;
        const haystack = `${pr.number} ${pr.title} ${pr.headRef} ${pr.baseRef} ${pr.author}`.toLowerCase();

        if (number ? pr.number === number : words.every((word) => haystack.includes(word))) response.items.push(pr);
      }

      if (offset < page.items.length) break;
      offset = 0;
      position = page.next;

      if (!position) lane++;
    }

    const current = await prs.repositories.selected(response.repositoryName);

    if (
      current.row.id !== selected.row.id ||
      current.row.revision !== selected.row.revision ||
      current.mapping.revision !== selected.mapping.revision
    )
      throw invalidCursor();
    response.nextCursor = cursor.next(lane, position, offset);
    response.state = "ready";

    return response;
  } catch (cause) {
    if (cause instanceof ConnectError && [Code.NotFound, Code.InvalidArgument].includes(cause.code)) throw cause;

    return pickerFailure(response, githubFailure(cause), cause instanceof GitHubHttpFailure ? cause.retryAt : 0);
  }
}
