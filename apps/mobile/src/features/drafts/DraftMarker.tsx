import { useCallback, useMemo, useSyncExternalStore, useEffect, useState } from "react";
import { Text } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { styles, useColors } from "../../ui/theme";

export function DraftMarker({ threadId }: { threadId: string }) {
  const c = useColors();
  const { drafts, client } = useSession();
  const [remote, setRemote] = useState(false);
  useEffect(() => {
    const update = () => {
      if (client && drafts)
        void drafts.remote
          .load(client.api, drafts.deviceId)
          .then((page) => setRemote(page.threadIds.includes(threadId)))
          .catch(() => {});
    };

    update();

    return drafts?.subscribeRemote(update);
  }, [drafts, client, threadId]);
  const target = useMemo(() => create(ui.ComposerDraftTargetSchema, { threadId }), [threadId]);

  const subscribe = useCallback(
    (notify: () => void) => drafts?.local.subscribeKey(target, notify) ?? (() => {}),
    [drafts, target],
  );

  const local = useSyncExternalStore(subscribe, () => Boolean(drafts?.local.get(target)));
  const present = local || remote;

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
