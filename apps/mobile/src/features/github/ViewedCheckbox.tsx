import { useState } from "react";
import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { mutationUnconfirmed } from "@canopy/domain/github-mutations";
import { Checkbox } from "../../ui/Checkbox";
import { Notice } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { useMutation } from "./useMutation";
import { OpenMutationSource } from "./OpenMutationSource";

export function ViewedCheckbox({
  file,
  snapshot,
  stale,
  onState,
  onSettled,
}: {
  file: github.PullRequestFile;
  snapshot: github.PullRequestSnapshot;
  stale: boolean;
  onState: (path: string, state: string) => void;
  onSettled: () => Promise<void>;
}) {
  const { send, receipt, busy, online, clear } = useMutation(snapshot);
  const [optimistic, setOptimistic] = useState<boolean>();
  const [source, setSource] = useState(file);

  if (source !== file) {
    setSource(file);
    setOptimistic(undefined);
    clear();
  }

  const c = useColors(),
    type = useTypography();

  const uncertain = receipt && mutationUnconfirmed(receipt);

  async function toggle(viewed: boolean) {
    if (busy || !online || stale || snapshot.stale || uncertain) return;
    setOptimistic(viewed);
    onState(file.path, viewed ? "VIEWED" : "UNVIEWED");
    const result = await send("viewed", { path: file.path, viewed });

    if (result?.state === "succeeded") await onSettled();
    else onState(file.path, file.viewerViewedState);
    setOptimistic(undefined);
  }

  return (
    <View style={{ gap: 4, width: 108 }}>
      <Checkbox
        label={busy ? "Saving…" : "Viewed"}
        checked={optimistic ?? file.viewerViewedState === "VIEWED"}
        disabled={busy || !online || stale || snapshot.stale || !file.viewerViewedState || !!uncertain}
        onChange={(v) => void toggle(v)}
      />
      {file.viewerViewedState === "DISMISSED" && (
        <Text style={[type.meta, { color: c.muted }]}>Changed since you viewed</Text>
      )}
      {!!receipt?.detail && <Notice error>{receipt.detail}</Notice>}
      {uncertain && <OpenMutationSource snapshot={snapshot} />}
    </View>
  );
}
