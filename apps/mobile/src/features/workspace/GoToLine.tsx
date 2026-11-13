import { useState } from "react";
import { Text, View } from "react-native";
import type { WorkspaceFile } from "@canopy/domain/workspace-file";
import { Button } from "../../ui/Button";
import { TextInput } from "../../ui/TextInput";
import { Overlay } from "../../ui/Overlay";
import { styles, useColors } from "../../ui/theme";

export function GoToLine({
  document,
  visible,
  onClose,
}: {
  document: WorkspaceFile;
  visible: boolean;
  onClose: () => void;
}) {
  const [line, setLine] = useState("");
  const c = useColors();

  return (
    <Overlay visible={visible} onClose={onClose} label="Go to line">
      <View style={{ padding: 20, gap: 16 }}>
        <Text style={[styles.body, { color: c.text }]}>Go to line</Text>
        <TextInput
          accessibilityLabel="Line or range"
          placeholder="31 or 31-40"
          value={line}
          onChangeText={setLine}
          autoCapitalize="none"
          style={[styles.body, { color: c.text, minHeight: 48 }]}
        />
        <Button
          title="Go to line"
          variant="primary"
          onPress={() => {
            const match = /^(\d+)(?:-(\d+))?$/.exec(line);
            const start = Number(match?.[1]);
            const end = Number(match?.[2] ?? start);

            if (Number.isSafeInteger(start) && start > 0 && end >= start && end <= document.text.split("\n").length) {
              document.locate({ line: start, end, column: 1 });
              onClose();
            }
          }}
        />
      </View>
    </Overlay>
  );
}
