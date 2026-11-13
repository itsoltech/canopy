import { View, Text } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import type { useThreadRewind } from "./useThreadRewind";

export function RewindHistory({
  turns,
  turn,
  open,
  toggle,
  actions,
  readOnly,
}: {
  turns: readonly ui.Turn[];
  turn: ui.Turn;
  open: boolean;
  toggle: () => void;
  actions: ReturnType<typeof useThreadRewind>;
  readOnly: boolean;
}) {
  const c = useColors();
  const group = turns.filter((entry) => entry.rewindId === turn.rewindId);
  const first = Math.min(...group.map((entry) => entry.ordinal));
  const count = group.filter((entry) => entry.trigger === "user" && !entry.withdrawn).length;
  const undo = !turns.some((entry) => !entry.inherited && entry.ordinal >= first && entry.rewindId !== turn.rewindId);

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, paddingBottom: 12 }}>
      <Text style={[styles.meta, { color: c.muted }]}>
        {count} {count === 1 ? "message" : "messages"} rewound
      </Text>
      <Button title={open ? "Hide" : "Show"} variant="ghost" onPress={toggle} />
      {undo && !readOnly ? (
        <>
          <Button title="Undo" variant="ghost" disabled={actions.busy} onPress={() => actions.restore(turn.rewindId)} />
          <Button
            title="Edit message"
            variant="ghost"
            disabled={actions.busy}
            onPress={() => actions.recover(turn.rewindId)}
          />
        </>
      ) : null}
    </View>
  );
}
