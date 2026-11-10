import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { Button, Notice } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";

export function PageControls({
  page,
  busy,
  error,
  previous,
  next,
  retry,
}: {
  page?: github.PullRequestPageInfo;
  busy: boolean;
  error: string;
  previous?: (() => void) | undefined;
  next: () => void;
  retry: () => void;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <View style={{ gap: 8 }}>
      {!!error && (
        <>
          <Notice error>{error}</Notice>
          <Button variant="ghost" title="Retry" onPress={retry} />
        </>
      )}
      {!!page?.detail && <Notice>{page.detail}</Notice>}
      {page?.stale && <Notice>Last verified data shown. Connect to refresh this page.</Notice>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {!!previous && <Button title="Previous page" variant="ghost" disabled={busy} onPress={previous} />}
        {!!page?.nextCursor && <Button title="Next page" variant="ghost" disabled={busy} onPress={next} />}
      </View>
      {busy && <Text style={[type.small, { color: c.muted }]}>Loading page…</Text>}
    </View>
  );
}
