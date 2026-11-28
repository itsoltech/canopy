import { useRef } from "react";
import { Code } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { issueOptions, threadOptions } from "./reference-options";
import { MentionOptions } from "./MentionOptions";
import type { ActiveTrigger } from "./mention-trigger";
import type { MentionOption } from "./useMentionSuggestions";
import { useReferenceSearch } from "./useReferenceSearch";

interface Props {
  scope: ui.MentionScope | undefined;
  onPick: (option: MentionOption) => void;
  inline?: boolean;
}

export function ReferenceSuggestions({ trigger, ...props }: Props & { trigger: ActiveTrigger | undefined }) {
  if (trigger?.char !== "#") return null;
  const key = JSON.stringify([props.scope?.threadId, props.scope?.workspaceId, trigger.invocation]);

  return <ReferenceResults key={key} {...props} query={trigger.query} />;
}

function ReferenceResults({ scope, query, onPick, inline }: Props & { query: string }) {
  const { client, searches } = useSession();
  const excludeThreadId = scope?.threadId ?? "";
  const canSearchTracker = Boolean(scope?.workspaceId || scope?.threadId);
  const arrival = useRef(0);
  const received = (options: MentionOption[]) => ({ order: ++arrival.current, options });

  const threads = useReferenceSearch(query, async (api, signal) => {
    const result = await searches.read(
      `SearchThreads:${excludeThreadId}:${query}`,
      (fetchSignal) => api.searchThreads({ query, excludeThreadId, limit: 20 }, { signal: fetchSignal }),
      8000,
      signal,
    );

    return received(threadOptions(result));
  });

  const tracker = useReferenceSearch(
    query,
    async (api, signal) => {
      const response = await api.searchIssues(
        { scope, query, limit: 20, includePullRequests: true },
        { timeoutMs: 25_000, signal },
      );

      return {
        ...received(issueOptions(response, query)),
        warnings: response.warnings,
        connectedSources: response.connectedSources,
      };
    },
    canSearchTracker,
  );

  // A late group goes below the results already under the user's finger.
  const options = [threads.data, tracker.data]
    .flatMap((page) => (page ? [page] : []))
    .sort((a, b) => a.order - b.order)
    .flatMap((page) => page.options);

  const warnings = [...(tracker.data?.warnings ?? [])];

  if (threads.error) warnings.push("Could not search threads.");

  if (tracker.error)
    warnings.push(
      tracker.error.code === Code.Unimplemented
        ? "Update the gateway to search issues and pull requests."
        : "Could not search issues and pull requests.",
    );

  const pending = threads.loading || tracker.loading;

  const empty = !client
    ? "Connect to the gateway to search."
    : tracker.data?.connectedSources === 0
      ? "No matches. Check repository access in Settings → GitHub, or Jira and Linear access in Settings → Connectors."
      : !canSearchTracker
        ? "No threads match."
        : query
          ? "No matches. Try another title, key or number."
          : "Search by title, key, number or URL.";

  const notice =
    !canSearchTracker && client
      ? "Choose a workspace to search issues and pull requests."
      : options.length && pending
        ? threads.loading
          ? "Searching threads…"
          : "Searching issues and pull requests…"
        : undefined;

  const retryTracker = !tracker.loading && (tracker.error || tracker.data?.warnings.length);

  function retry() {
    if (threads.error) threads.retry();

    if (retryTracker) tracker.retry();
  }

  return (
    <MentionOptions
      queryKey={query}
      inline={inline}
      label="References"
      maxHeight={320}
      options={options}
      loading={!options.length && pending}
      notice={notice}
      warnings={warnings}
      onRetry={threads.error || retryTracker ? retry : undefined}
      empty={empty}
      onPick={onPick}
    />
  );
}
