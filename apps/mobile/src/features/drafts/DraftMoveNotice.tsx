import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { Button } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import type { MobileComposerState } from "./store";

export function DraftMoveNotice({ draft, children }: { draft?: MobileComposerState; children?: ReactNode }) {
  const c = useColors();

  return draft?.moved ? (
    <View style={[styles.row, { flex: 1, minWidth: 0 }]}>
      <Text numberOfLines={1} accessibilityLiveRegion="polite" style={[styles.meta, { color: c.muted, flex: 1 }]}>
        {draft.moved}
      </Text>
      <Button title="Dismiss" variant="ghost" size="sm" onPress={() => draft.dismissMove()} />
    </View>
  ) : (
    children
  );
}
