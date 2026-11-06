import { useEffect, useState } from "react";
import { Text } from "react-native";
import type { ui } from "@canopy/contracts";
import { Sheet } from "../../ui/components";
import { SearchField } from "../../ui/SearchField";
import { styles, useColors } from "../../ui/theme";
import { HistoryFooter } from "../../ui/HistoryFooter";

/** Searching requests earlier pages on demand, including inherited turns, until the beginning. */
export function ThreadSearchSheet({
  visible,
  turns,
  items,
  onClose,
  hasMore,
  history,
}: {
  visible: boolean;
  turns: ui.Turn[];
  items: ui.TimelineItem[];
  onClose: () => void;
  hasMore: boolean;
  history: { loading: boolean; error: string; load: () => Promise<void> };
}) {
  const c = useColors();
  const [query, setQuery] = useState("");

  const matches = [
    ...turns.map((turn) => ({ id: turn.id, text: turn.messageText || turn.inputText })),
    ...items.flatMap((entry) =>
      entry.item?.content.case === "agentMessage"
        ? [{ id: entry.item.itemId, text: entry.item.content.value.text }]
        : [],
    ),
  ].filter((entry) => entry.text.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (visible && query.trim() && hasMore && !history.loading && !history.error) void history.load();
  }, [visible, query, hasMore, history]);

  return (
    <Sheet visible={visible} title="Search thread" onClose={onClose}>
      <SearchField label="Search messages" value={query} onChange={setQuery} />
      {query.trim() &&
        matches.map((hit) => (
          <Text key={hit.id} style={[styles.body, { color: c.body }]}>
            {hit.text}
          </Text>
        ))}
      {query.trim() && <HistoryFooter hasMore={hasMore} history={history} />}
    </Sheet>
  );
}
