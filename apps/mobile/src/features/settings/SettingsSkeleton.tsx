import { View } from "react-native";
import { Skeleton, useSkeleton } from "../../ui/Skeleton";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRowContent } from "./SettingsRow";
import { useTypography } from "../../ui/theme";

/** Unknown list lengths use row geometry; known forms keep their real rows mounted instead. */
export function SettingsSkeletonRows({ rows = 2, controls = false }: { rows?: number; controls?: boolean }) {
  const loading = useSkeleton();
  const type = useTypography();

  if (!loading) return null;

  return (
    <View accessible accessibilityLabel="Loading settings" accessibilityState={{ busy: true }} style={{ gap: 20 }}>
      {Array.from({ length: rows }, (_, index) => (
        <SettingsRowContent
          key={index}
          copy={
            <View style={{ gap: 2 }}>
              <Skeleton style={{ width: "45%", height: type.chrome.lineHeight }} />
              <Skeleton style={{ width: "80%", height: type.meta.lineHeight }} />
            </View>
          }
          control={controls ? <View style={{ height: 44 }} /> : undefined}
        />
      ))}
    </View>
  );
}

export function SettingsSkeletonGroups({ titles }: { titles: string[] }) {
  return (
    <>
      {titles.map((title) => (
        <SettingsGroup key={title} title={title}>
          <SettingsSkeletonRows controls />
        </SettingsGroup>
      ))}
    </>
  );
}
