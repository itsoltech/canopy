import { View } from "react-native";
import { Skeleton, useSkeleton } from "../../ui/Skeleton";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";

/** Unknown list lengths use row geometry; known forms keep their real rows mounted instead. */
export function SettingsSkeletonRows({ rows = 2, controls = false }: { rows?: number; controls?: boolean }) {
  const loading = useSkeleton();

  if (!loading) return null;

  return (
    <View style={{ gap: 12 }}>
      {Array.from({ length: rows }, (_, index) => (
        <SettingsRow
          key={index}
          title=" "
          description=" "
          control={controls ? <Skeleton style={{ height: 44 }} /> : undefined}
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
