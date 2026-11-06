type PowerEvent = "suspend" | "resume" | "unlock-screen";

export interface PowerEvents {
  on(event: PowerEvent, listener: () => void): void;
}

/** Best-effort sleep announcement; a short background wake must not advertise an online computer. */
export function monitorPower(
  events: PowerEvents,
  send: (state: string) => Promise<void>,
  schedule: (run: () => void, ms: number) => () => void = (run, ms) => {
    const timer = setTimeout(run, ms);

    return () => clearTimeout(timer);
  },
) {
  let cancelWake: (() => void) | undefined;
  let active = true;

  const announce = (state: string) => {
    if (active) void send(state).catch(() => {});
  };

  events.on("suspend", () => {
    cancelWake?.();
    cancelWake = undefined;
    announce("sleeping");
  });
  events.on("resume", () => {
    cancelWake?.();
    announce("waking");
    cancelWake = schedule(() => {
      cancelWake = undefined;
      announce("connected");
    }, 5000);
  });
  events.on("unlock-screen", () => {
    cancelWake?.();
    cancelWake = undefined;
    announce("connected");
  });

  return () => {
    active = false;
    cancelWake?.();
  };
}
