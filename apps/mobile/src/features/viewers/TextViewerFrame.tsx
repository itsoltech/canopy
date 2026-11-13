import type { ReactNode } from "react";
import { View } from "react-native";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { ContentInsets, useContentInsets } from "../../ui/ScreenFrame";
import { styles, useColors } from "../../ui/theme";
import { Text } from "react-native";

export function TextViewerFrame({
  embedded = false,
  title,
  onClose,
  actions,
  children,
}: {
  embedded?: boolean;
  title: string;
  onClose: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  const insets = useContentInsets();
  const c = useColors();

  if (!embedded)
    return (
      <FullScreenViewer title={title} onClose={onClose} actions={actions}>
        {children}
      </FullScreenViewer>
    );

  return (
    <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          padding: 12,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
        }}
      >
        <Text numberOfLines={1} style={[styles.chrome, { color: c.text, flex: 1 }]}>
          {title}
        </Text>
        {actions}
      </View>
      <ContentInsets.Provider value={{ ...insets, top: 0, bottom: 0 }}>{children}</ContentInsets.Provider>
    </View>
  );
}
