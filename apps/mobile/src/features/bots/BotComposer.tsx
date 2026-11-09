import { ComposerBox } from "../threads/ComposerBox";
import { QuoteTray } from "../quotes/QuoteTray";
import type { useBotMessage } from "./useBotMessage";

export function BotComposer({
  name,
  message,
  compact,
  disabled,
  running,
  onExpand,
  onStop,
}: {
  name: string;
  message: ReturnType<typeof useBotMessage>;
  compact: boolean;
  disabled: boolean;
  running: boolean;
  onExpand: () => void;
  onStop: () => void;
}) {
  const { draft, quotes, busy } = message;

  return (
    <>
      <QuoteTray draft={message.quoteDraft} inline busy={busy} />
      <ComposerBox
        compact={compact}
        inline
        onExpand={onExpand}
        placeholder={name ? `Message ${name}` : ""}
        text={draft.value.text}
        onChange={draft.setText}
        badges={draft.badges}
        files={quotes.length}
        shellCommands={false}
        label="Message to your bot"
        onSend={() => void message.send()}
        running={running}
        onStop={onStop}
        disabled={disabled}
        busy={busy}
      />
    </>
  );
}
