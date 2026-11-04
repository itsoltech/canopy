/** Native input owns composition state. Some iOS keyboards commit a replacement without
 * compositionend; a non-composing input must recover both suggestions and the editor's keys.
 * Reading/querying is safe during composition, rewriting the DOM for markdown is not.
 */
export class InputSession {
  composing = false;

  constructor(readonly read: (format: boolean) => void) {}

  start(): void {
    this.composing = true;
  }

  input(event: { readonly isComposing: boolean; readonly inputType: string }): void {
    this.composing = event.isComposing;
    this.read(!this.composing && !event.inputType.startsWith("history"));
  }

  end(): void {
    this.reset();
    this.read(true);
  }

  reset(): void {
    this.composing = false;
  }
}
