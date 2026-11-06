import { Text, View } from "react-native";
import { Button } from "./Button";
import { styles, useColors } from "./theme";
import { ConversationSkeleton } from "./Skeleton";

/** An explicit retry also lets short conversations request history without a scroll gesture. */
export function HistoryFooter({
  hasMore,
  history,
  skeleton,
  empty,
}: {
  hasMore?: boolean;
  skeleton?: boolean;
  empty?: boolean;
  history: {
    loading: boolean;
    error: string;
    load: () => Promise<void>;
  };
}) {
  const c = useColors();

  if (skeleton) return <ConversationSkeleton />;

  if (empty) return <Text style={[styles.meta, { color: c.muted, textAlign: "center" }]}>Start a conversation</Text>;

  if (!hasMore) return null;

  return (
    <View style={{ gap: 8, paddingVertical: 8 }}>
      <Button
        title={history.loading ? "Loading earlier messages…" : "Show earlier messages"}
        variant="ghost"
        size="sm"
        disabled={history.loading}
        onPress={() => void history.load()}
      />
      {!!history.error && <Text style={[styles.caption, { color: c.muted }]}>{history.error}</Text>}
    </View>
  );
}
