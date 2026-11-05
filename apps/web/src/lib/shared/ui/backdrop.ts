/**
 * Backdrop dismissal for a modal `<dialog>`: spread the handlers on the dialog element.
 * A click closes it only when the press also started on the backdrop, so a text selection that is
 * dragged out of the dialog and released over the backdrop keeps the dialog open.
 */
export function backdropDismiss(dismiss: () => void) {
  let pressed = false;

  return {
    onpointerdown: (event: PointerEvent) => {
      pressed = event.target === event.currentTarget;
    },
    onclick: (event: MouseEvent) => {
      if (pressed && event.target === event.currentTarget) dismiss();
      pressed = false;
    },
  };
}
