import { ComposerBox } from "../threads/ComposerBox";
import { QuoteTray } from "../quotes/QuoteTray";
import type { useBotMessage } from "./useBotMessage";
import { AttachButton, AttachmentChips } from "../attachments/Attachments";
import { PasteTarget } from "../attachments/FileIntake";
import { Button, Notice } from "../../ui/components";

export function BotComposer({
  name,
  message,
  compact,
  disabled,
  running,
  stopping,
  onExpand,
  onStop,
}: {
  name: string;
  message: ReturnType<typeof useBotMessage>;
  compact: boolean;
  disabled: boolean;
  running: boolean;
  stopping: boolean;
  onExpand: () => void;
  onStop: () => void;
}) {
  const { draft, quotes, busy } = message;

  return (
    <>
      <QuoteTray draft={message.quoteDraft} inline busy={busy} />
      {message.error && <Button title="Load saved draft" variant="ghost" size="sm" onPress={message.reloadDraft} />}
      <AttachmentChips files={draft.files.files} onRemove={draft.remove} />
      {draft.files.blocker ? <Notice>{draft.files.blocker}</Notice> : null}
      <PasteTarget draft={draft.files} disabled={disabled || busy || !message.loaded}>
        <ComposerBox
          compact={compact}
          inline
          onExpand={onExpand}
          placeholder={name ? `Message ${name}` : ""}
          text={draft.value.text}
          onChange={draft.setText}
          badges={draft.badges}
          files={quotes.length + draft.files.files.length}
          attachment={<AttachButton draft={draft.files} disabled={disabled || busy || !message.loaded} />}
          canSend={!draft.files.blocker && message.loaded}
          shellCommands={false}
          label="Message to your bot"
          onSend={() => void message.send()}
          running={running}
          stopWhileRunning
          onStop={onStop}
          disabled={disabled || (!running && !message.loaded)}
          busy={busy || stopping}
        />
      </PasteTarget>
    </>
  );
}
