import { useState } from "react";
import { BOT_APPROVAL_OPTIONS } from "@canopy/domain/bot-chat";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { PickerSheet } from "../../ui/Picker";

/** Update only the policy against the latest bot definition; the gateway decides what still needs approval. */
export function BotApprovalPolicy({ botId, disabled }: { botId: string; disabled: boolean }) {
  const { client, online } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function change(approvalPolicy: string) {
    if (!client || disabled || !online || busy) return;
    setBusy(true);
    setError("");

    try {
      const { bot } = await client.api.getBot({ botId });

      if (!bot?.configuration) throw new Error("Bot unavailable");
      await client.api.updateBot({ botId, configuration: { ...bot.configuration, approvalPolicy } });
    } catch {
      setError("Could not change approval policy. Check the connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        title="Change approval policy"
        disabled={disabled || !online}
        busy={busy}
        onPress={() => setOpen(true)}
      />
      {error && <Notice error>{error}</Notice>}
      <PickerSheet
        title="Ask for approval"
        visible={open}
        onClose={() => setOpen(false)}
        sections={[{ options: BOT_APPROVAL_OPTIONS }]}
        onSelect={(policy) => void change(policy)}
      />
    </>
  );
}
