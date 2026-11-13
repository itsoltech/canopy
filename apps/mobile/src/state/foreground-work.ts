interface ActivitySource {
  readonly currentState: string | null | undefined;
  addEventListener(event: "change", listener: (state: string) => void): { remove(): void };
}

/** End foreground work synchronously on suspension, before a React commit can restart effects. */
export function whileForeground(activity: ActivitySource, start: () => () => void) {
  let stop: (() => void) | undefined;

  const changed = (state: string | null | undefined) => {
    if (state === "active") stop ??= start();
    else {
      stop?.();
      stop = undefined;
    }
  };

  const subscription = activity.addEventListener("change", changed);
  changed(activity.currentState);

  return () => {
    subscription.remove();
    stop?.();
    stop = undefined;
  };
}
