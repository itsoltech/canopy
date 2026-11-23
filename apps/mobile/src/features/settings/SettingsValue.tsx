import { Text } from "react-native";
import { useColors, useTypography } from "../../ui/theme";
import { SettingsRow } from "./SettingsGroup";
import { Skeleton } from "../../ui/Skeleton";
import { SettingsMatch } from "./SettingsSearch";

export function SettingsValue({ title, value, description }: { title: string; value?: string; description?: string }) {
  const c = useColors("settings");
  const type = useTypography();

  return (
    <SettingsRow title={title} description={description}>
      <Skeleton>
        <Text selectable style={[type.chrome, { color: c.muted }]}>
          <SettingsMatch text={value || "—"} />
        </Text>
      </Skeleton>
    </SettingsRow>
  );
}
