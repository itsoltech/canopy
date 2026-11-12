import { View } from "react-native";
import type { github } from "@canopy/contracts";
import { Button, Notice } from "../../ui/components";

export function PageStatus({
  page,
  busy,
  error,
  retry,
}: {
  page?: github.PullRequestPageInfo;
  busy: boolean;
  error: string;
  retry: () => void;
}) {
  return (
    <View accessibilityState={{ busy }} style={{ gap: 8 }}>
      {!!error && <Notice error>{error}</Notice>}
      {!!page?.detail && <Notice>{page.detail}</Notice>}
      {!!(page?.stale && page.detail) && <Notice>Last verified data shown. Connect to refresh this page.</Notice>}
      {!!(error || page?.detail) && <Button title="Retry" variant="ghost" disabled={busy} onPress={retry} />}
    </View>
  );
}
