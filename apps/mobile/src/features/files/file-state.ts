import type { ui } from "@canopy/contracts";

/** Presentation shared by the workspace's native editor, image and binary views. */
export interface ThreadFileState {
  file: ui.ThreadFile | undefined;
  lookup: ui.ThreadFile | undefined;
  text: string;
  draft: string;
  dirty: boolean;
  editable: boolean;
  readOnly: boolean;
  loading: boolean;
  busy: boolean;
  error: string;
  setDraft(text: string): void;
  reload(selected?: string): void;
  discard(): void;
  save(): Promise<boolean>;
  remove(): Promise<boolean>;
}
