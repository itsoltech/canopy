import { createContext, useContext, useState, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { SettingsButtonAlignment } from "../../ui/density";
import { Badge } from "../../ui/Badge";
import { SheetContent } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { Skeleton, useSkeleton } from "../../ui/Skeleton";
import { useColors, useTypography, weightedFont } from "../../ui/theme";
import { SettingsMatch } from "./SettingsSearch";

export const GroupRow = createContext(false);

export const SettingsRowScope = createContext<{
  accessory?: ReactNode;
  caption?: string;
  reset?: (title: string) => ReactNode;
}>({});

function RowCopy({
  title,
  description,
  caption,
  soon,
}: {
  title: string;
  description?: string;
  caption?: string;
  soon?: boolean;
}) {
  const c = useColors("settings");
  const type = useTypography();

  return (
    <View style={{ minWidth: 0, flexShrink: 1, gap: 2 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Skeleton style={{ maxWidth: "100%" }}>
          <Text style={[type.chrome, weightedFont(type.chrome.fontFamily, "medium"), { color: c.text }]}>
            <SettingsMatch text={title} />
          </Text>
        </Skeleton>
        {soon && <Badge>Soon</Badge>}
      </View>
      {description && (
        <Skeleton style={{ alignSelf: "flex-start" }}>
          <Text style={[type.meta, { color: c.muted }]}>
            <SettingsMatch text={description} />
          </Text>
        </Skeleton>
      )}
      {caption && (
        <Skeleton style={{ alignSelf: "flex-start" }}>
          <Text style={[type.meta, { color: c.muted }]}>
            <SettingsMatch text={caption} />
          </Text>
        </Skeleton>
      )}
    </View>
  );
}

export function SettingsRowContent({
  copy,
  control,
  reset,
  soon,
  inlineControl,
  controlWidth = 240,
  chevron,
}: {
  copy: ReactNode;
  control?: ReactNode;
  reset?: ReactNode;
  soon?: boolean;
  inlineControl?: boolean;
  controlWidth?: number;
  chevron?: boolean;
}) {
  const c = useColors("settings");
  const [wide, setWide] = useState(false);
  const loading = useSkeleton();
  const beside = inlineControl || wide || !control;

  return (
    <View
      onLayout={control && !inlineControl ? (event) => setWide(event.nativeEvent.layout.width >= 552) : undefined}
      style={{
        flexDirection: beside ? "row" : "column",
        alignItems: beside ? "center" : "stretch",
        gap: beside ? 16 : 8,
      }}
    >
      <View style={{ minWidth: 0, flex: beside ? 1 : undefined }}>{copy}</View>
      {control ? (
        <View
          pointerEvents={soon || loading ? "none" : "auto"}
          accessibilityElementsHidden={soon || loading}
          importantForAccessibility={soon || loading ? "no-hide-descendants" : "auto"}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            opacity: soon ? 0.5 : 1,
            maxWidth: beside ? "55%" : "100%",
          }}
        >
          {beside && reset}
          <Skeleton style={{ width: inlineControl ? undefined : controlWidth, minWidth: 0, flexShrink: 1 }}>
            <SettingsButtonAlignment.Provider value={beside ? "flex-end" : "flex-start"}>
              {control}
            </SettingsButtonAlignment.Provider>
          </Skeleton>
          {!beside && reset}
        </View>
      ) : (
        reset
      )}
      {chevron && <Icon name="chevron-right" color={c.faint} />}
    </View>
  );
}

export function SettingsRow({
  title,
  description,
  children,
  control,
  onPress,
  soon,
  style,
  accessory,
  inlineControl,
  controlWidth = 240,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  control?: ReactNode;
  onPress?: () => void;
  soon?: boolean;
  style?: StyleProp<ViewStyle>;
  accessory?: ReactNode;
  inlineControl?: boolean;
  controlWidth?: number;
}) {
  const c = useColors("settings");
  const grouped = useContext(GroupRow);
  const inSheet = useContext(SheetContent);
  const scope = useContext(SettingsRowScope);
  const loading = useSkeleton();
  const reset = accessory ?? scope.accessory ?? scope.reset?.(title);

  const rowStyle: StyleProp<ViewStyle> = [
    { paddingHorizontal: grouped || inSheet ? 0 : 12, paddingVertical: grouped || inSheet ? 0 : 10, gap: 8 },
    style,
  ];

  const body = (
    <>
      <SettingsRowContent
        copy={<RowCopy title={title} description={description} caption={scope.caption} soon={soon} />}
        control={control}
        reset={reset}
        soon={soon}
        inlineControl={inlineControl}
        controlWidth={controlWidth}
        chevron={!!onPress}
      />
      {children}
    </>
  );

  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: loading || soon }}
      disabled={loading || soon}
      onPress={onPress}
      style={({ pressed }) => [
        rowStyle,
        { minHeight: 44, justifyContent: "center", backgroundColor: pressed ? c.pressed : "transparent" },
      ]}
    >
      {body}
    </Pressable>
  ) : (
    <View style={rowStyle}>{body}</View>
  );
}
