/** A short state of the open file, shown as one pill in its bar instead of a row that pushes the text down. */
export interface FileNotice {
  text: string;
  /** Full sentence for the tooltip and screen readers when `text` is a short label. */
  detail?: string;
  /** Work in progress: the pill shows a spinner. */
  busy?: boolean;
  action?: { label: string; run: () => void };
}
