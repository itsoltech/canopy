import { app } from "electron";

let requested = false;
let link: string | undefined;

export function registerSecondInstance(
  scheme: string,
  quitting: () => boolean,
  open: (link: string | undefined) => void,
): void {
  app.on("second-instance", (_event, argv) => {
    const nextLink = argv.find((arg) => arg.startsWith(`${scheme}://`));

    if (quitting()) {
      requested = true;
      link ??= nextLink;

      return;
    }

    open(nextLink);
  });
}

export function relaunchAfterQuit(): void {
  if (requested) app.relaunch(link ? { args: [link] } : undefined);
}
