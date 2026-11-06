import { Text } from "react-native";
import { styles, useColors } from "../../ui/theme";
import { SettingsRow } from "./SettingsGroup";

export function SettingsValue({ title, value, description }: { title: string; value?: string; description?: string }) {
  const c = useColors();

  return (
    <SettingsRow title={title} description={description}>
      <Text selectable style={[styles.chrome, { color: c.muted }]}>
        {value || "—"}
      </Text>
    </SettingsRow>
  );
}
