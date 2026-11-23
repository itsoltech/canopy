import type { ui } from "@canopy/contracts";
import { ReferenceSuggestions } from "./ReferenceSuggestions";
import { MentionOptions } from "./MentionOptions";
import { useMentionSuggestions, type MentionOption } from "./useMentionSuggestions";
import type { ActiveTrigger } from "./mention-trigger";

const emptyText = {
  "/": "No commands match.",
  $: "No skills or plugins match.",
  "@": "No files match.",
} as const;

/**
 * The mention list over the composer while the caret is in a trigger ("/", "$", "@", "#"): compact rows grouped
 * as on the web; tapping one puts its badge in place of the typed query.
 */
export function MentionSuggestions({
  scope,
  trigger,
  onPick,
}: {
  scope: ui.MentionScope | undefined;
  trigger: ActiveTrigger | undefined;
  onPick: (option: MentionOption) => void;
}) {
  const { options, loading, error } = useMentionSuggestions(scope, trigger?.char === "#" ? undefined : trigger);

  if (!trigger) return null;

  if (trigger.char === "#") return <ReferenceSuggestions scope={scope} trigger={trigger} onPick={onPick} />;

  return (
    <MentionOptions
      queryKey={`${trigger.char}:${trigger.query}`}
      options={options}
      loading={loading}
      error={error}
      empty={emptyText[trigger.char]}
      onPick={onPick}
    />
  );
}
