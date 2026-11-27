/**
 * The footer panels share space and open on hover only: a click on their icon opens the full page instead.
 * Only the active panel can be open.
 */
export function footerPopovers() {
  let active = $state<"updates" | "provider-usage" | "usage" | "workers">();

  function panel(id: NonNullable<typeof active>) {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const isOpen = () => active === id;

    function close() {
      clearTimeout(closeTimer);

      if (isOpen()) active = undefined;
    }

    $effect(() => () => clearTimeout(closeTimer));

    return {
      isOpen,
      close,
      get superseded() {
        return active !== undefined && !isOpen();
      },
      setOpen(open: boolean) {
        if (open) active = id;
        else close();
      },
      enter(event: PointerEvent) {
        if (event.pointerType !== "mouse" || !window.matchMedia("(min-width: 40rem)").matches) return;
        clearTimeout(closeTimer);
        active = id;
      },
      leave(event: PointerEvent) {
        if (event.pointerType !== "mouse" || !isOpen()) return;
        clearTimeout(closeTimer);
        closeTimer = setTimeout(close, 250);
      },
    };
  }

  return {
    usage: panel("usage"),
    workers: panel("workers"),
    updates: panel("updates"),
    providerUsage: panel("provider-usage"),
  };
}

export type FooterPopover = ReturnType<typeof footerPopovers>["updates"];
