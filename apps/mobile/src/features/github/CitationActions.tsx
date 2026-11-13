import { useState } from "react";
import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { GitHubActions, type GitHubAction } from "./GitHubActions";
import { usePrCitationTarget } from "./citation-target";
import { QuoteEditor } from "../quotes/QuoteEditor";
import * as Linking from "expo-linking";
import { safeHref } from "@canopy/domain/markdown";

/** Native selection stays available; Cite opens the existing editable-excerpt sheet. */
export function CitationActions({
  quote,
  actions = [],
  url = "",
  name = "Item",
}: {
  quote?: ui.Quote;
  actions?: GitHubAction[];
  url?: string;
  name?: string;
}) {
  const target = usePrCitationTarget();
  const [citing, setCiting] = useState(false);

  const canopyActions: GitHubAction[] =
    target && quote
      ? [
          { label: "Send to agent", icon: "paper-airplane", run: () => target(quote) },
          { label: "Cite", run: () => setCiting(true) },
        ]
      : [];

  const href = safeHref(url);
  const choices = [...actions, ...(href ? [{ label: "Open on GitHub", run: () => void Linking.openURL(href) }] : [])];

  if (!choices.length && !canopyActions.length) return null;

  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center" }}>
      <GitHubActions name={name} actions={choices} canopyActions={canopyActions} />
      {citing && target && quote && <QuoteEditor quote={quote} onSave={target} onClose={() => setCiting(false)} />}
    </View>
  );
}
