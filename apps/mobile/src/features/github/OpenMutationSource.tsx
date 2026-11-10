import * as Linking from "expo-linking";
import type { github } from "@canopy/contracts";
import { Button } from "../../ui/components";

export function OpenMutationSource({ snapshot }: { snapshot: github.PullRequestSnapshot }) {
  const ref = snapshot.summary?.ref;

  return (
    <Button
      title="Open on GitHub"
      variant="ghost"
      size="sm"
      onPress={() => {
        if (ref) void Linking.openURL(`https://github.com/${ref.repositoryName}/pull/${ref.number}`);
      }}
    />
  );
}
