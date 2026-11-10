import type { ui } from "@canopy/contracts";
import { Field, Notice } from "../../ui/components";

export function WorkspaceCloneFields({
  worker,
  url,
  name,
  busy,
  setUrl,
  setName,
}: {
  worker: ui.Worker;
  url: string;
  name: string;
  busy: boolean;
  setUrl: (value: string) => void;
  setName: (value: string) => void;
}) {
  return (
    <>
      <Field
        label="Git URL"
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
      />
      <Notice>{worker.name} clones with its own Git sign-in. Private repositories need access there.</Notice>
      <Field label="Directory name" value={name} onChangeText={setName} editable={!busy} />
    </>
  );
}
