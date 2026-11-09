import { View } from "react-native";
import { useColors } from "../../ui/theme";

/** The row's accessibility label announces unread state; this mark never takes layout space. */
export function SidebarUnread({ unread }: { unread: boolean }) {
  const c = useColors();

  return unread ? (
    <View
      accessible={false}
      style={{
        position: "absolute",
        top: 6,
        right: 6,
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: c.brand,
      }}
    />
  ) : null;
}
