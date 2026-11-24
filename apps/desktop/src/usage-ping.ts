import { app, ipcMain, net, screen, session, type IpcMainInvokeEvent } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { usagePingBody, usagePingEndpoint, usagePingRetryMs, usagePingTimeoutMs } from "@canopy/domain/usage-ping";
import { writePrivateFile } from "./runtime/private-file.ts";

const storedPing = Schema.Struct({
  enabled: Schema.Boolean,
  consentRecorded: Schema.optional(Schema.Literal(true)),
  lastPingDate: Schema.optional(Schema.String),
});

const decodeStoredPing = Schema.decodeUnknownSync(Schema.fromJsonString(storedPing));
const decodeEnabled = Schema.decodeUnknownSync(Schema.Boolean);

export class DesktopUsagePing {
  private readonly path: string;
  private sending = false;
  private retryAfter = 0;

  constructor(directory: string) {
    this.path = join(directory, "usage-ping.json");
  }

  private read(): typeof storedPing.Type {
    try {
      const state = decodeStoredPing(readFileSync(this.path, "utf8"));

      // Older builds also wrote enabled: true when reserving a day with the default setting.
      return { ...state, enabled: state.consentRecorded === true && state.enabled };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { enabled: false };
      throw error;
    }
  }

  private write(state: typeof storedPing.Type) {
    writePrivateFile(this.path, JSON.stringify(state) + "\n");
  }

  registerIpc(authorize: (event: IpcMainInvokeEvent) => void, onOnline: (event: IpcMainInvokeEvent) => void) {
    ipcMain.handle("canopy:usage-ping", (event) => {
      authorize(event);

      return this.read().enabled;
    });
    ipcMain.handle("canopy:set-usage-ping", (event, value: boolean) => {
      authorize(event);
      const enabled = decodeEnabled(value);
      this.write({ ...this.read(), enabled, consentRecorded: true });

      return enabled;
    });
    ipcMain.handle("canopy:usage-ping-online", (event) => {
      authorize(event);
      onOnline(event);
    });
  }

  async sendIfDue() {
    if (!app.isPackaged || this.sending || Date.now() < this.retryAfter || !net.isOnline()) return;
    this.sending = true;

    try {
      const state = this.read();
      const today = new Date().toISOString().slice(0, 10);

      if (!state.enabled || state.lastPingDate === today) return;

      // Reserve the date before sending so a restart during the request cannot send it twice.
      this.write({ ...state, lastPingDate: today });

      if (!(await deliverPing())) {
        this.retryAfter = Date.now() + usagePingRetryMs;
        this.write({ ...this.read(), lastPingDate: undefined });
      }
    } catch {
      // An unreadable preference must keep the ping off.
      this.retryAfter = Date.now() + usagePingRetryMs;
    } finally {
      this.sending = false;
    }
  }
}

async function deliverPing() {
  try {
    const { width, height } = screen.getPrimaryDisplay().size;

    const response = await session.fromPartition("canopy-usage-ping").fetch(usagePingEndpoint, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(usagePingTimeoutMs),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": session.defaultSession.getUserAgent(),
      },
      body: usagePingBody({
        version: app.getVersion(),
        os: process.platform,
        arch: process.arch,
        language: app.getLocale(),
        screen: `${width}x${height}`,
      }),
    });

    void response.body?.cancel().catch(() => {});

    return response.ok;
  } catch {
    return false;
  }
}
