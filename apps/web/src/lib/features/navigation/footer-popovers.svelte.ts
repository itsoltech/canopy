/** The footer panels share space. Only the active panel can be open, and an explicit press takes priority over hover. */
export function footerPopovers() {
  let active = $state<"updates" | "provider-usage">();
  let pinned = $state(false);

  function panel(id: NonNullable<typeof active>) {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const isOpen = () => active === id;

    function close() {
      clearTimeout(closeTimer);

      if (isOpen()) {
        active = undefined;
        pinned = false;
      }
    }

    $effect(() => () => clearTimeout(closeTimer));

    return {
      isOpen,
      close,
      get pinned() {
        return isOpen() && pinned;
      },
      get superseded() {
        return active !== undefined && !isOpen();
      },
      setOpen(open: boolean) {
        if (open) active = id;
        else close();
      },
      press() {
        clearTimeout(closeTimer);

        if (isOpen() && pinned) close();
        else {
          active = id;
          pinned = true;
        }
      },
      enter(event: PointerEvent) {
        if (event.pointerType !== "mouse" || !window.matchMedia("(min-width: 40rem)").matches) return;
        clearTimeout(closeTimer);

        if (!pinned) active = id;
      },
      leave(event: PointerEvent) {
        if (event.pointerType !== "mouse" || !isOpen() || pinned) return;
        clearTimeout(closeTimer);
        closeTimer = setTimeout(close, 250);
      },
    };
  }

  return { updates: panel("updates"), providerUsage: panel("provider-usage") };
}

export type FooterPopover = ReturnType<typeof footerPopovers>["updates"];
