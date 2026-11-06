import type { Ref } from "react";
import { FlatList, type FlatListProps } from "react-native";
import { useContentInsets } from "../../ui/ScreenFrame";
import { styles } from "../../ui/theme";

/** Inverted: the oldest end gets the floating header inset; the latest end has its measured composer spacer. */
export function TimelineList<Item>({
  contentContainerStyle,
  ...props
}: FlatListProps<Item> & { ref?: Ref<FlatList<Item>> }) {
  const insets = useContentInsets();

  return (
    <FlatList
      {...props}
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      contentContainerStyle={[
        styles.page,
        contentContainerStyle,
        { paddingBottom: 16 + insets.top, paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right },
      ]}
    />
  );
}
