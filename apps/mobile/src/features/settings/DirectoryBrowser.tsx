import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Sheet } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { font, useColors, useTypography } from "../../ui/theme";
import { DirectoryPicker } from "./DirectoryPicker";

/** A compact destination field; directory navigation has its own bounded list. */
export function DirectoryBrowser({
  workerId,
  value,
  onChange,
}: {
  workerId: string;
  value: string;
  onChange: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const c = useColors();
  const type = useTypography();

  return (
    <View style={{ gap: 6 }}>
      <Text style={[type.body, { fontFamily: font.medium, color: c.text }]}>Directory</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={value ? `Choose directory: ${value}` : "Choose directory"}
        disabled={!workerId}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 48,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderWidth: 1,
          borderColor: c.line,
          borderRadius: 8,
          backgroundColor: pressed ? c.pressed : c.surface,
        })}
      >
        <Icon name="folder" />
        <Text
          numberOfLines={1}
          ellipsizeMode="middle"
          style={[type.chrome, { flex: 1, color: value ? c.text : c.muted }]}
        >
          {value || "Choose directory"}
        </Text>
        <Icon name="chevron-right" />
      </Pressable>
      <Sheet title="Choose directory" visible={open} scroll={false} onClose={() => setOpen(false)}>
        {open && (
          <DirectoryPicker
            key={workerId}
            workerId={workerId}
            initialPath={value}
            onChoose={(path) => {
              onChange(path);
              setOpen(false);
            }}
          />
        )}
      </Sheet>
    </View>
  );
}
