import { View } from "react-native";
import type { github } from "@canopy/contracts";
import { Button } from "../../ui/components";
import { PageStatus } from "./PageStatus";

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
  return (
    <View style={{ gap: 8 }}>
      <PageStatus page={page} busy={busy} error={error} retry={retry} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {!!previous && <Button title="Previous page" variant="ghost" disabled={busy} onPress={previous} />}
        {!!page?.nextCursor && <Button title="Next page" variant="ghost" disabled={busy} onPress={next} />}
      </View>
    </View>
  );
}
