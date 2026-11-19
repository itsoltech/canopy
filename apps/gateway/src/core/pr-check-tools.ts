import { moduleDisabledMessage } from "../store/module-access.ts";
import { fromJsonString, type JsonObject, type JsonValue } from "@bufbuild/protobuf";
import { GitPrContextSchema } from "@canopy/contracts";
import { Code } from "@connectrpc/connect";
import {
  checkOutcome,
  DEFAULT_PR_CHECK_EVENTS,
  judgeChecks,
  noteChecks,
  PR_MERGE_CONFLICT_NOTE,
  type AgentBusCall,
  type PrCheckEvent,
} from "@canopy/domain";
import { matchLinkedPullRequest, readWatchedChecks, type LinkedPullRequest } from "../github/check-watch-read.ts";
import { githubName } from "../github/discovery.ts";
import { githubFailure } from "../github/http.ts";
import type { CallSource, PrCheckWatchRow, ThreadRow } from "../store/index.ts";
import type { PrCheckWatches } from "./pr-check-watches.ts";

/**
 * The agent's pull request tools (docs/agent-bus.md, "Checki CI"): link_pull_request, watch_pr_checks,
 * list_pr_watches, cancel_pr_watch.
 * Scoped to the calling thread and its linked pull requests; reads use the owner's GitHub account in the gateway.
 */

export type PrCheckCall = Extract<
  AgentBusCall,
  { tool: "link_pull_request" | "watch_pr_checks" | "list_pr_watches" | "cancel_pr_watch" }
>;

const MAX_ACTIVE_PER_THREAD = 10;
const DEFAULT_TIMEOUT_MINUTES = 60;

/** How long watch_pr_checks waits for a pull request the agent just opened to be linked (github/detection.ts). */
const LINK_WAIT_MS = 10_000;

/** A reason for the model (AgentBus returns errors named Invalid to it). */
class Refusal extends Error {
  override readonly name = "Invalid";
}

const EVENT_WORDS: Record<PrCheckEvent, string> = {
  failure: "a check fails",
  complete: "every check has finished",
  each: "each check finishes",
};

const URL_FORM = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]{0,9})\/?$/i;
const SHORT_FORM = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]{0,9})$/;

export const pullRequestUrl = (repository: string, number: number) => `https://github.com/${repository}/pull/${number}`;

function linkReference(value: string) {
  const match = URL_FORM.exec(value.trim()) ?? SHORT_FORM.exec(value.trim());

  if (!match || Number(match[2]) > 2_147_483_647)
    throw new Refusal("Name the pull request by its URL or owner/repo#123.");

  const repository = match[1]!.toLowerCase();
  const number = Number(match[2]);

  return { repository, number, url: pullRequestUrl(repository, number) };
}

async function threadRepositories(watches: PrCheckWatches, threadId: string) {
  const { run, owner } = watches.github;
  const workspace = (await run((s) => s.prPickerContext(owner, threadId)))[0];
  const saved = (await run((s) => s.detectionContext(owner, threadId)))[0];
  const repositories = new Set([githubName(workspace?.git_origin ?? "")]);

  if (saved) {
    const context = fromJsonString(GitPrContextSchema, JSON.stringify(saved.context));

    for (const remote of context.remotes)
      if (["origin", "upstream", context.pushRemote, context.upstreamRemote].includes(remote.name))
        for (const name of [...remote.fetchRepositories, ...remote.pushRepositories])
          repositories.add(githubName(name));
  }

  repositories.delete("");

  if (!repositories.size)
    throw new Refusal(
      "This thread has no detected GitHub workspace repository. Link the pull request from this thread's Pull requests panel.",
    );

  return repositories;
}

async function link(
  watches: PrCheckWatches,
  call: Extract<PrCheckCall, { tool: "link_pull_request" }>,
  caller: ThreadRow,
): Promise<JsonValue> {
  const reference = linkReference(call.args.pull_request);
  const repositories = await threadRepositories(watches, caller.id);

  try {
    const result = await watches.github.prs.linkFromAgent(caller.id, reference.url, repositories);
    const summary = result.summary;
    const ref = summary.ref;

    if (!ref) throw new Refusal("The pull request has no repository reference. Retry link_pull_request.");

    return {
      pull_request: `${ref.repositoryName}#${ref.number}`,
      url: pullRequestUrl(ref.repositoryName, ref.number),
      linked: true,
      ...(result.alreadyLinked && { already_linked: true }),
      state: summary.state,
      ...(result.headRef && { head_ref: result.headRef }),
      ...(summary.headSha && { head_sha: summary.headSha }),
      note: result.alreadyLinked
        ? "This pull request was already linked to the thread."
        : "Pull request linked to the thread.",
    };
  } catch (cause) {
    if (cause instanceof Refusal) throw cause;
    const failure = githubFailure(cause);

    if (failure.code === Code.PermissionDenied || failure.code === Code.Unauthenticated)
      throw new Refusal(
        "Canopy cannot access this pull request. Check the account and repository access in Settings → GitHub account.",
      );

    throw new Refusal(failure.rawMessage);
  }
}

export function watchView(row: PrCheckWatchRow): JsonObject {
  return {
    watch_id: row.id,
    pull_request: `${row.repository_name}#${row.number}`,
    url: pullRequestUrl(row.repository_name, row.number),
    status: row.status,
    ...(row.end_reason && { end_reason: row.end_reason }),
    notify_on: row.notify_on,
    head_sha: row.head_sha,
    until: new Date(row.expires_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
    ...(row.ended_at && { ended_at: new Date(row.ended_at).toISOString() }),
  };
}

async function linkedPullRequests(watches: PrCheckWatches, threadId: string): Promise<LinkedPullRequest[]> {
  const found: LinkedPullRequest[] = [];
  let offset = 0;

  do {
    const list = await watches.github.prs.list(threadId, 20, offset);

    for (const link of list.links) {
      const ref = link.summary?.ref;

      if (ref?.id) found.push({ id: ref.id, repository: ref.repositoryName, number: ref.number });
    }

    offset = list.nextOffset;
  } while (offset);

  return found;
}

/** The linked pull request the call names; a pull request the agent just opened may take a few seconds to link. */
async function resolve(watches: PrCheckWatches, threadId: string, text: string): Promise<LinkedPullRequest> {
  const deadline = Date.now() + LINK_WAIT_MS;

  for (;;) {
    const match = matchLinkedPullRequest(text, await linkedPullRequests(watches, threadId));

    if ("pr" in match) return match.pr;

    if (Date.now() >= deadline || !/\d/.test(text)) throw new Refusal(match.problem);
    await Bun.sleep(1_000);
  }
}

async function watch(
  watches: PrCheckWatches,
  call: Extract<PrCheckCall, { tool: "watch_pr_checks" }>,
  source: CallSource,
  caller: ThreadRow,
  hops: number,
): Promise<JsonValue> {
  const existing = await watches.run((s) => s.byCall(source.callId));

  if (existing) return { ...watchView(existing), watching: existing.status === "active" };

  if ((await watches.run((s) => s.activeCount(caller.id))) >= MAX_ACTIVE_PER_THREAD)
    throw new Refusal(`this thread already has ${MAX_ACTIVE_PER_THREAD} active watches; cancel_pr_watch stops one`);

  const pr = await resolve(watches, caller.id, call.args.pull_request);
  const prs = watches.github.prs;
  const notifyOn = [...new Set(call.args.notify_on ?? DEFAULT_PR_CHECK_EVENTS)];

  function readFailed(cause: unknown): never {
    throw new Refusal(
      `Canopy cannot read ${pr.repository}#${pr.number} on GitHub (${githubFailure(cause).rawMessage}). ` +
        "The user can connect a GitHub account with access to this repository in Settings → GitHub account.",
    );
  }

  const snapshot = await prs.load(pr.repository, pr.number, true).catch(readFailed);
  const state = snapshot.summary?.state ?? "";

  if (state === "merged" || state === "closed")
    throw new Refusal(`${pr.repository}#${pr.number} is already ${state}; there is nothing to watch`);

  const head = snapshot.summary?.headSha ?? "";

  const reference = {
    pull_request: `${pr.repository}#${pr.number}`,
    url: pullRequestUrl(pr.repository, pr.number),
    head_sha: head,
  };

  if (!snapshot.stale && snapshot.mergeability === "conflicting")
    return { ...reference, watching: false, end_reason: "conflict", note: PR_MERGE_CONFLICT_NOTE };

  const checks = await readWatchedChecks(prs, pr.id, snapshot).catch(readFailed);
  const verdict = judgeChecks(notifyOn, checks, { seen: {}, settled: false });
  const failed = checks.filter((c) => checkOutcome(c.state) === "failed");

  const base = {
    ...reference,
    checks: { ...verdict.counts },
    failed: noteChecks(failed).checks.map((check) => ({ ...check })),
  };

  if (verdict.outcome === "passed" && !snapshot.stale && snapshot.mergeability !== "unknown")
    return {
      ...base,
      watching: false,
      note: "Every check of this commit already passed; nothing to watch. Call again after pushing a new commit.",
    };

  const expiresAt = new Date(prs.accounts.http.now() + (call.args.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000);

  const row = await watches.run((s) =>
    s.create({
      id: Bun.randomUUIDv7(),
      ownerUserId: caller.owner_user_id,
      threadId: caller.id,
      pullRequestId: pr.id,
      callId: source.callId,
      notifyOn,
      hops,
      expiresAt,
      headSha: head,
      seen: verdict.outcome === "passed" ? {} : verdict.seen,
      settled: verdict.settled && verdict.outcome !== "passed",
    }),
  );

  if (!row) throw new Refusal(moduleDisabledMessage("threads"));

  return {
    watch_id: row.id,
    ...base,
    notify_on: notifyOn,
    until: expiresAt.toISOString(),
    watching: true,
    note:
      `You will get a message in this thread when ${notifyOn.map((e) => EVENT_WORDS[e]).join(", or when ")}` +
      `${failed.length ? " (the checks that already failed are listed here, not sent again)" : ""}. ` +
      "Merge conflicts also end the watch with a message. " +
      "New commits pushed to the pull request are followed. Do not poll or sleep for it.",
  };
}

export async function prCheckTool(
  watches: PrCheckWatches,
  call: PrCheckCall,
  source: CallSource,
  caller: ThreadRow,
  hops: number,
): Promise<JsonValue> {
  switch (call.tool) {
    case "link_pull_request":
      return link(watches, call, caller);

    case "watch_pr_checks":
      return watch(watches, call, source, caller, hops);

    case "list_pr_watches": {
      const rows = await watches.run((s) => s.ofThread(caller.id, 20));

      return {
        watches: rows.map(watchView),
        ...(rows.length === 0 && { note: "This thread has no CI check watches." }),
      };
    }

    case "cancel_pr_watch": {
      const row = await watches.run((s) => s.cancel(caller.id, call.args.watch_id));

      if (!row) throw new Refusal(`watch ${call.args.watch_id} not found in this thread; list_pr_watches shows them`);

      return { ...watchView(row), cancelled: row.end_reason === "cancelled" };
    }
  }
}
