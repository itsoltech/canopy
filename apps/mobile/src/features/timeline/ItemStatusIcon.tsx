import { Text, View } from "react-native";
import { ItemStatus } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";
import { Icon } from "../../ui/Icon";
import { Spinner } from "../../ui/Badge";
import { styles } from "../../ui/theme";
import { useTone } from "../../ui/tone";

/** In progress, failed, declined or interrupted; completed shows nothing, the default state (web: ItemStatusIcon). */
export function ItemStatusIcon({ status, count }: { status: ItemStatus; count?: number }) {
  const sky = useTone("sky").text;
  const rose = useTone("rose").text;
  const orange = useTone("orange").text;

  if (status === ItemStatus.IN_PROGRESS)
    // The label stays for screen readers only, as on a phone-width web page.
    return (
      <View style={[styles.row, { gap: 4 }]} accessibilityLabel={count === undefined ? "Running" : `${count} running`}>
        <Spinner color={sky} />
        {count !== undefined && <Text style={[styles.workMeta, { color: sky }]}>{count}</Text>}
      </View>
    );

  const look: { icon: IconName; label: string; color: string } | undefined =
    status === ItemStatus.FAILED
      ? { icon: "x-circle", label: "Failed", color: rose }
      : status === ItemStatus.DECLINED
        ? { icon: "hand-raised", label: "Declined", color: rose }
        : status === ItemStatus.INTERRUPTED
          ? { icon: "stop", label: "Interrupted", color: orange }
          : undefined;

  if (!look) return null;

  return (
    <View
      style={[styles.row, { gap: 4 }]}
      accessibilityLabel={count === undefined ? undefined : `${count} ${look.label.toLowerCase()}`}
    >
      <Icon name={look.icon} size={14} color={look.color} />
      <Text style={[styles.workMeta, { color: look.color }]}>{count ?? look.label}</Text>
    </View>
  );
}
