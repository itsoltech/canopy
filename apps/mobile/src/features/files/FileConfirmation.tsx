import { Text, View } from "react-native";
import { Button } from "../../ui/Button";
import { Overlay } from "../../ui/Overlay";
import { styles, useColors } from "../../ui/theme";

export type FileConfirmationKind = "delete" | "discard";

export function FileConfirmation({
  kind,
  name,
  computer,
  onCancel,
  onConfirm,
}: {
  kind: FileConfirmationKind | undefined;
  name: string;
  computer: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const c = useColors();
  const deleting = kind === "delete";
  const title = deleting ? "Delete file?" : "Discard unsaved changes?";

  return (
    <Overlay visible={Boolean(kind)} onClose={onCancel} label={title}>
      <View style={{ padding: 20, gap: 16 }}>
        <Text accessibilityRole="header" style={[styles.body, { color: c.text }]}>
          {title}
        </Text>
        <Text style={[styles.body, { color: c.muted }]}>
          {deleting
            ? `Delete ${name} from ${computer}. This cannot be undone.`
            : `Your edits to ${name} are not saved.`}
        </Text>
        <Button title="Cancel" onPress={onCancel} />
        <Button title={deleting ? "Delete file" : "Discard changes"} variant="danger" onPress={onConfirm} />
      </View>
    </Overlay>
  );
}
