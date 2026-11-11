import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { Button, Notice } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";

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
  const c = useColors();
  const type = useTypography();

  return (
    <View style={{ gap: 8 }}>
      {!!error && (
        <>
          <Notice error>{error}</Notice>
          <Button title="Retry" variant="ghost" onPress={retry} />
        </>
      )}
      {!!page?.detail && <Notice>{page.detail}</Notice>}
      {page?.stale && <Notice>Last verified data shown. Connect to refresh this page.</Notice>}
      {busy && <Text style={[type.meta, { color: c.muted }]}>Loading…</Text>}
    </View>
  );
}
