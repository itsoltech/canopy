import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Text } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { styles, useColors } from "../../ui/theme";

export function DraftMarker({ threadId }: { threadId: string }) {
  const c = useColors();
  const { drafts } = useSession();
  const target = useMemo(() => create(ui.ComposerDraftTargetSchema, { threadId }), [threadId]);

  const subscribe = useCallback(
    (notify: () => void) => drafts?.local.subscribeKey(target, notify) ?? (() => {}),
    [drafts, target],
  );

  const present = useSyncExternalStore(subscribe, () => Boolean(drafts?.local.get(target)));

  return (
    <Text
      accessibilityLabel={present ? "Draft" : undefined}
      accessibilityElementsHidden={!present}
      importantForAccessibility={present ? "auto" : "no-hide-descendants"}
      style={[styles.meta, { width: 36, color: c.muted, opacity: present ? 1 : 0 }]}
    >
      Draft
    </Text>
  );
}
