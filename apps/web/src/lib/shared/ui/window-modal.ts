// Every native dialog tracks showModal order, including Escape, native close and unmount.
// DOM order cannot identify the top layer: a later-opened modal may occur earlier in the document.
const modals: HTMLDialogElement[] = [];

function markTopModal() {
  for (const modal of modals) modal.removeAttribute("data-window-modal-top");

  for (let index = modals.length - 1; index >= 0; index--) {
    if (!modals[index]!.isConnected || !modals[index]!.matches(":modal")) modals.splice(index, 1);
  }

  modals.at(-1)?.setAttribute("data-window-modal-top", "");
}

/** Svelte action: only the topmost modal can contribute native window drag strips. */
export function windowModal(dialog: HTMLDialogElement) {
  const toggle = (event: ToggleEvent) => {
    if (event.newState === "open") {
      const index = modals.indexOf(dialog);

      if (index >= 0) modals.splice(index, 1);
      modals.push(dialog);
    }

    // beforetoggle runs before :modal changes; update before the next paint.
    queueMicrotask(markTopModal);
  };

  dialog.addEventListener("beforetoggle", toggle);
  // Escape/requestClose does not emit beforetoggle in every Chromium path. Observe only the dialog's
  // open attribute, never mutations in its animated body, to restore the previous strip on native close.
  const changes = new MutationObserver(markTopModal);
  changes.observe(dialog, { attributes: true, attributeFilter: ["open"] });

  if (dialog.matches(":modal")) {
    modals.push(dialog);
    markTopModal();
  }

  return {
    destroy() {
      dialog.removeEventListener("beforetoggle", toggle);
      changes.disconnect();
      const index = modals.indexOf(dialog);

      if (index >= 0) modals.splice(index, 1);
      dialog.removeAttribute("data-window-modal-top");
      markTopModal();
    },
  };
}
