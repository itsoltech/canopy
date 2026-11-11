import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { Item, ui } from "@canopy/contracts";
import { loadThreadItem } from "@canopy/domain/thread-content";
import { useSession } from "../../state/session";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";

export function LazyItemContent({
  reference,
  threadId,
  onLoad,
}: {
  reference: ui.ThreadSyncContent;
  threadId: string;
  onLoad: (item: Item) => void;
}) {
  const { client } = useSession();
  const c = useColors();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [abort] = useState(() => new AbortController());
  useEffect(() => () => abort.abort(), [abort]);

  const load = async () => {
    if (!client || loading) return;
    setLoading(true);
    setError("");

    try {
      const item = await loadThreadItem(
        reference,
        (offset, length) =>
          client.api.getThreadSyncContent(
            {
              threadId,
              sha256: reference.sha256,
              offset,
              length,
            },
            { signal: abort.signal },
          ),
        abort.signal,
        threadId,
      );

      onLoad(item);
    } catch {
      if (!abort.signal.aborted) setError("Could not load the full item. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ gap: 4, alignItems: "flex-start", paddingVertical: 4 }}>
      <Button title="Load full item" variant="ghost" size="sm" busy={loading} onPress={() => void load()} />
      <Text style={[styles.caption, { color: c.muted }]}>{error || "Showing a preview."}</Text>
    </View>
  );
}
