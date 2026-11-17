import { useRef, useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { Notice } from "../../ui/Alert";
import { Switch } from "../../ui/Switch";
import { IconButton } from "../../ui/Button";
import { styles, useColors, useTypography } from "../../ui/theme";

/** The thread override uses project and owner defaults until explicitly changed. */
export function ThreadAutoArchive({ thread, disabled }: { thread: ui.Thread; disabled: boolean }) {
  const c = useColors();
  const type = useTypography();
  const settings = useAppearance();
  const { client, online } = useSession();
  const { updateThread } = useOverview();
  const running = useRef(false);
  const [draft, setDraft] = useState<boolean>();
  const [failed, setFailed] = useState(false);
  const [help, setHelp] = useState(false);
  const project = settings.projectDefaults(thread.projectId)?.autoArchiveOnMerge;
  const inherited = project ?? settings.user?.threadDefaults?.autoArchiveOnMerge ?? false;
  const override = draft ?? thread.autoArchiveOnMerge;
  const enabled = override ?? inherited;

  const inactive =
    disabled ||
    draft !== undefined ||
    !client ||
    !online ||
    !settings.user ||
    !!thread.archivedAt ||
    thread.status === "archived" ||
    !!thread.deletedAt;

  const source =
    override !== undefined
      ? "Set for this thread."
      : project !== undefined
        ? "Uses the project default."
        : "Uses your default.";

  async function save(value: boolean) {
    if (!client || inactive || running.current) return;
    running.current = true;
    setDraft(value);
    setFailed(false);

    try {
      const response = await client.api.updateThread({ threadId: thread.id, autoArchiveOnMerge: value });

      if (response.thread) updateThread(response.thread);
    } catch {
      setFailed(true);
    } finally {
      running.current = false;
      setDraft(undefined);
    }
  }

  return (
    <View
      style={{ minWidth: 0, paddingHorizontal: 8, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: c.rule }}
    >
      <View style={[styles.row, { minHeight: 48, gap: 0 }]}>
        <Text style={[type.chrome, { flex: 1, minWidth: 0, color: c.soft }]}>Auto-archive after merge</Text>
        <View style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}>
          <IconButton
            icon="information-circle"
            size="sm"
            label="About auto-archive after merge"
            onPress={() => setHelp(!help)}
          />
        </View>
        <View style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}>
          <Switch
            size="sm"
            label="Auto-archive after merge"
            value={enabled}
            disabled={inactive}
            onChange={(value) => void save(value)}
          />
        </View>
      </View>
      {help && (
        <Text style={[type.meta, { color: c.muted, paddingBottom: 8 }]}>
          {source} Waits for all linked pull requests to merge and active work to finish.
        </Text>
      )}
      {failed ? <Notice error>Could not save auto-archive. Check the connection, then retry.</Notice> : null}
    </View>
  );
}
