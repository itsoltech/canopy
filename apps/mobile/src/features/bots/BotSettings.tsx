import { useRef, useState } from "react";
import { router } from "expo-router";
import * as Crypto from "expo-crypto";
import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { BotPermissionSettings } from "./BotPermissionSettings";
import { BotModelSettings } from "./BotModelSettings";
import { BotAppearanceSettings } from "./BotAppearanceSettings";
import { BotSettingsExtras } from "./BotSettingsExtras";
import { appearanceError, normalizeColor } from "@canopy/domain/bot-draft";
import { useSettingsResource } from "../settings/resource";
import { useComputerHome } from "../computers/presence";

export function BotSettings({
  bot,
  selectedRule = "",
  creating = false,
  onClose,
}: {
  bot: bots.Bot;
  selectedRule?: string;
  creating?: boolean;
  onClose: () => void;
}) {
  const { client, online, bots: known, updateBots } = useSession();
  const home = useComputerHome(bot.nodeId);
  const names = useSettingsResource(`bot-names:${bot.id}`, (api) => api.listBots({ includeArchived: true }));
  const [config, setConfig] = useState(() => create(bots.BotConfigurationSchema, bot.configuration));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const pending = useRef({ configuration: "", id: "" });

  const draftError = appearanceError(
    config,
    (names.data?.bots ?? known).filter((row) => row.nodeId === bot.nodeId).map((row) => row.configuration?.name ?? ""),
    creating ? undefined : bot.configuration?.name,
  );

  const valid = !home.away && !draftError && !!config.model && !!config.provider;

  async function save() {
    if (!client || !online || !valid || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");

    try {
      const configuration = create(bots.BotConfigurationSchema, {
        ...config,
        color: normalizeColor(config.color) ?? config.color,
        name: config.name.trim(),
      });

      if (creating) {
        const serialized = JSON.stringify(configuration);

        if (pending.current.configuration !== serialized)
          pending.current = { configuration: serialized, id: Crypto.randomUUID() };

        const result = await client.api.createBot(
          { configuration, clientRequestId: pending.current.id },
          { timeoutMs: 20_000 },
        );

        const created = result.bot;

        if (!created) throw new Error("Missing created bot");
        updateBots([...known.filter((row) => row.id !== created.id), created]);
        onClose();
        router.push({ pathname: "/bot/[id]", params: { id: created.id } });

        return;
      }

      await client.api.updateBot({ botId: bot.id, configuration }, { timeoutMs: 20_000 });
      onClose();
    } catch {
      setError(
        creating
          ? "Could not confirm bot creation. Check the connection and retry."
          : "Could not save bot settings. Check the values and try again.",
      );
    } finally {
      setBusy(false);
      saving.current = false;
    }
  }

  return (
    <Sheet
      title={creating ? "Create bot" : "Bot settings"}
      visible
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <Field
        label="Name"
        value={config.name}
        editable={!busy}
        onChangeText={(name) => setConfig({ ...config, name })}
        maxLength={80}
      />
      <Field
        label="Standing instructions"
        value={config.instructions}
        editable={!busy}
        onChangeText={(instructions) => setConfig({ ...config, instructions })}
        multiline
        maxLength={32000}
      />
      <BotAppearanceSettings config={config} onChange={setConfig} disabled={busy} />
      <BotModelSettings bot={bot} config={config} onChange={setConfig} disabled={busy || home.away} guided={creating} />
      {config.name.trim() && draftError ? <Notice error>{draftError}</Notice> : null}
      <BotPermissionSettings
        botId={creating ? undefined : bot.id}
        selectedRule={selectedRule}
        config={config}
        onChange={setConfig}
        disabled={busy}
      />
      {error ? <Notice error>{error}</Notice> : null}
      <Button
        variant="primary"
        title={creating ? "Create bot" : "Save changes"}
        busy={busy}
        disabled={!online || !valid}
        onPress={() => void save()}
      />
      {!creating && <BotSettingsExtras bot={bot} onClose={onClose} disabled={busy || home.away || !online} />}
    </Sheet>
  );
}
