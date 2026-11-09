import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { bots, ui } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { useSession } from "../../state/session";
import { useComputerHome } from "../computers/presence";
import { PickerSheet } from "../../ui/Picker";
import { Button, Notice, Sheet } from "../../ui/components";
import { confirm } from "../../ui/Confirm";
import { BotSettings } from "./BotSettings";
import { ItemComputerMove } from "../settings/ItemComputerMove";

export function BotActions({ bot, visible, onClose }: { bot: bots.Bot; visible: boolean; onClose: () => void }) {
  const settings = useAppearance();
  const { client, online, updateBots } = useSession();
  const home = useComputerHome(bot.nodeId);
  const [panel, setPanel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sidebar = settings.user?.sidebar;
  const pinned = sidebar?.pinnedBotIds.includes(bot.id) ?? false;
  const disabled = !online || home.away || busy;

  async function act(kind: string) {
    if (!client || disabled) return;
    setBusy(true);
    setError("");

    try {
      if (kind === "pin")
        await client.api.updateUserSettings({
          expectedVersion: settings.user?.version ?? 0n,
          sidebar: create(ui.SidebarSettingsSchema, {
            ...create(ui.SidebarSettingsSchema, sidebar),
            pinnedBotIds: pinned
              ? (sidebar?.pinnedBotIds ?? []).filter((id) => id !== bot.id)
              : [...(sidebar?.pinnedBotIds ?? []), bot.id],
          }),
        });
      else if (kind === "delete") await client.api.deleteBot({ botId: bot.id });
      else if (bot.archived) await client.api.unarchiveBot({ botId: bot.id });
      else await client.api.archiveBot({ botId: bot.id });
      updateBots((await client.api.listBots({ includeArchived: true })).bots);
      await settings.reload();
      onClose();
    } catch {
      await settings.reload().catch(() => undefined);
      setError("Could not update this bot. Check the connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PickerSheet
        title={bot.configuration?.name || "Bot actions"}
        visible={visible}
        onClose={onClose}
        footer={error || settings.error ? <Notice error>{error || settings.error}</Notice> : undefined}
        sections={[
          {
            options: [
              ...(!bot.archived
                ? [
                    {
                      value: "pin",
                      label: pinned ? "Unpin bot" : "Pin bot",
                      disabled: disabled || !settings.user || settings.saving,
                    },
                  ]
                : []),
              { value: "edit", label: "Edit bot", disabled },
              ...(!bot.nodeId ? [{ value: "move", label: "Move to a computer", disabled }] : []),
              { value: "archive", label: bot.archived ? "Unarchive bot" : "Archive bot", disabled },
              { value: "delete", label: "Delete bot", disabled, tone: "danger" },
            ],
          },
        ]}
        onSelect={(kind) => {
          if (kind === "edit" || kind === "move") {
            onClose();
            setPanel(kind);
          } else if (kind === "delete")
            confirm({
              title: "Delete bot?",
              description: `This deletes “${bot.configuration?.name || "Bot"}” and its conversation. You cannot undo this.`,
              confirm: "Delete bot",
              action: () => void act(kind),
            });
          else if (kind === "pin" && pinned && settings.user?.general?.confirmUnpin)
            confirm({
              title: "Unpin bot?",
              description: "This bot stays in your conversations.",
              confirm: "Unpin bot",
              danger: false,
              action: () => void act(kind),
            });
          else if (kind === "archive" && !bot.archived && settings.user?.general?.confirmArchive)
            confirm({
              title: "Archive bot?",
              description: "This stops the bot’s work. You can find it in Archived bots.",
              confirm: "Archive bot",
              danger: false,
              action: () => void act(kind),
            });
          else void act(kind);
        }}
      />
      {panel === "edit" && <BotSettings bot={bot} onClose={() => setPanel("")} />}
      {panel === "move" && <ItemComputerMove item={{ kind: "bot", id: bot.id }} onClose={() => setPanel("")} />}
      <Sheet title="Bot actions" visible={!!error} onClose={() => setError("")}>
        <Notice error>{error}</Notice>
        <Button title="Close" onPress={() => setError("")} />
      </Sheet>
    </>
  );
}
