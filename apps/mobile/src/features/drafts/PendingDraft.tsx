import { Text, View } from "react-native";
import { Button } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import type { MobileComposerState } from "./store";
import { useSession } from "../../state/session";

export function PendingDraft({ draft }: { draft: MobileComposerState }) {
  const colors = useColors();
  const { client } = useSession();

  if ((!draft.pendingSend && !draft.pendingCreate) || draft.preparing || draft.reconciling || !draft.deliveryChecked)
    return null;

  return (
    <View style={{ gap: 4 }}>
      <Text style={[styles.meta, { color: colors.muted }]}>
        Send not confirmed. The previous message may have been sent. Editing starts a new message.
      </Text>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Button
          title="Edit draft"
          variant="ghost"
          size="sm"
          disabled={Boolean(draft.pendingCreate) && draft.preparing}
          onPress={() => draft.cancelSend(true, client?.api)}
        />
        <Button
          title="Discard draft"
          variant="ghost"
          size="sm"
          disabled={Boolean(draft.pendingCreate) && draft.preparing}
          onPress={() => {
            draft.cancelSend(true, client?.api);
            draft.clear();
          }}
        />
      </View>
    </View>
  );
}
