/** The disclosure owns cancellation; its animated body may outlive the open state. */
export class ContentExpansion {
  signal = $state<AbortSignal>();

  constructor(open: () => boolean) {
    $effect(() => {
      if (!open()) return;
      const abort = new AbortController();
      this.signal = abort.signal;

      return () => abort.abort();
    });
  }
}
