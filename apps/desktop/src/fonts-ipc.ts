import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { allowedFontAccess } from "./window-permissions.ts";
import { systemFonts } from "./system-fonts.ts";

export async function readSystemFonts(
  event: IpcMainInvokeEvent,
  authorize: (event: IpcMainInvokeEvent) => void,
  origin: string | undefined,
  enumerate = systemFonts,
): Promise<string[]> {
  authorize(event);

  if (
    !event.senderFrame ||
    !allowedFontAccess(event.senderFrame.url, origin, event.senderFrame === event.sender.mainFrame)
  )
    throw new Error("Untrusted font request");

  return enumerate();
}

export function registerFontsIpc(authorize: (event: IpcMainInvokeEvent) => void, origin: () => string | undefined) {
  ipcMain.handle("canopy:fonts", (event) => readSystemFonts(event, authorize, origin()));
}
