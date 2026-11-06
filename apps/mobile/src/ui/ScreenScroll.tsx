import { ScrollView, type ScrollViewProps } from "react-native";
import { useContentPadding, useContentInsets } from "./ScreenFrame";
import { styles } from "./theme";

/** Insets move with the content rather than shrinking the scroll viewport. */
export function ScreenScroll({
  contentContainerStyle,
  space = 16,
  innerLeft = false,
  innerRight = false,
  ...props
}: ScrollViewProps & { space?: number; innerLeft?: boolean; innerRight?: boolean }) {
  const padding = useContentPadding(space);
  const insets = useContentInsets();

  return (
    <ScrollView
      {...props}
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      scrollIndicatorInsets={insets}
      contentContainerStyle={[
        styles.page,
        contentContainerStyle,
        padding,
        innerLeft && { paddingLeft: space },
        innerRight && { paddingRight: space },
      ]}
    />
  );
}
