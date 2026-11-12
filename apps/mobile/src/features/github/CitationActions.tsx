import { useState } from "react";
import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { IconButton } from "../../ui/components";
import { GitHubActions, type GitHubAction } from "./GitHubActions";
import { usePrCitationTarget } from "./citation-target";
import { QuoteEditor } from "../quotes/QuoteEditor";

/** Native selection stays available; Cite opens the existing editable-excerpt sheet. */
export function CitationActions({ quote, actions = [] }: { quote: ui.Quote; actions?: GitHubAction[] }) {
  const target = usePrCitationTarget();
  const [citing, setCiting] = useState(false);

  const choices = [
    ...(target
      ? [
          { label: "Send to agent", run: () => target(quote) },
          { label: "Cite", run: () => setCiting(true) },
        ]
      : []),
    ...actions,
  ];

  if (!choices.length) return null;

  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center" }}>
      {target && <IconButton icon="paper-airplane" label="Send to agent" size="sm" onPress={() => target(quote)} />}
      <GitHubActions name="Item" actions={choices} />
      {citing && target && <QuoteEditor quote={quote} onSave={target} onClose={() => setCiting(false)} />}
    </View>
  );
}
