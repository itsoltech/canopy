import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import type { ComputerStore } from "../../computers/store.ts";
import type { GatewayRole } from "../../role.ts";
import { TailscaleFront, type FrontPolicy } from "./front.ts";
import { loadHttpsSettings, NO_HTTPS, saveHttpsSettings, type HttpsSettings } from "./https-settings.ts";
import {
  choosePort,
  httpsUrl,
  ownsEntry,
  parseServeConfig,
  serveError,
  serveOffArgs,
  serveOnArgs,
  serveStatusArgs,
} from "./serve.ts";
import type { Tailscale } from "./tailscale.ts";

export const ADMIN_DNS = "https://login.tailscale.com/admin/dns";

export type HttpsOptions = {
  tailscale: Tailscale;
  store: ComputerStore;
  role: GatewayRole;
  /** The web BFF's origin (CANOPY_WEB_ORIGIN); without it there is nothing to serve. */
  webOrigin?: string | undefined;
  log?: ((message: string) => void) | undefined;
};

type State = "off" | "on" | "error" | "unavailable";

/** HTTPS over Tailscale (docs/tailscale.md): one Serve entry from https://<MagicDNS name> to Canopy's
 * loopback front. Opt-in, off by default; Canopy touches only the entry it added and never Funnel. */
export class TailscaleHttps {
  #settings: HttpsSettings = NO_HTTPS;
  #state: State = "off";
  #error = "";
  #queue: Promise<unknown> = Promise.resolve();
  readonly #front = new TailscaleFront(() => this.#policy());

  constructor(readonly options: HttpsOptions) {}

  start() {
    return this.#serial(async () => {
      this.#settings = await loadHttpsSettings(this.options.store);
      await this.#apply();
    });
  }

  /** The Serve entry stays (it is persistent); while the gateway is down Tailscale answers with an error. */
  close() {
    return this.#serial(() => this.#front.close());
  }

  /** Follows Tailscale (a login, a new name, certificates turned on) and checks the entry is still there. */
  sync() {
    return this.#serial(() => this.#apply());
  }

  setEnabled(enabled: boolean) {
    return this.#serial(async () => {
      if (enabled && this.#reason().text) throw new ConnectError(this.#reason().text, Code.FailedPrecondition);
      await this.#save({ ...this.#settings, enabled });
      await this.#apply();
    });
  }

  /** 0 = automatic. A port another Serve entry uses is refused, and nothing changes. */
  setPort(port: number) {
    return this.#serial(async () => {
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new ConnectError("Enter a port from 1 to 65535", Code.InvalidArgument);
      const requested = port || null;

      if (requested !== null && this.#settings.enabled && !this.#reason().text) {
        try {
          const config = await this.#config();

          const own =
            this.#settings.serve && ownsEntry(config, this.#settings.serve) ? this.#settings.serve : undefined;

          choosePort(config, own, requested);
        } catch (error) {
          throw new ConnectError(error instanceof Error ? error.message : "", Code.FailedPrecondition);
        }
      }

      await this.#save({ ...this.#settings, port: requested });
      await this.#apply();
    });
  }

  message() {
    const reason = this.#reason();
    const serve = this.#settings.serve;

    return create(ui.TailscaleHttpsSchema, {
      enabled: this.#settings.enabled,
      state: this.#state,
      port: (this.#state === "on" ? serve?.port : undefined) ?? this.#settings.port ?? 0,
      portAutomatic: this.#settings.port === null,
      url: this.#state === "on" && serve ? httpsUrl(serve.host, serve.port) : "",
      error: this.#state === "error" ? this.#error : "",
      unavailable: reason.text,
      adminUrl: reason.admin,
      allowedLogin: this.options.tailscale.snapshot.login,
    });
  }

  /** Why it can't be on now: one reason, in the words Settings shows. */
  #reason(): { text: string; admin: string } {
    const snapshot = this.options.tailscale.snapshot;
    const text = (value: string, admin = "") => ({ text: value, admin });

    if (!this.options.webOrigin) return text("This gateway doesn't know where its web app runs.");

    if (snapshot.state !== "connected") return text("Connect this computer to Tailscale first.");

    if (!snapshot.magicDns || !snapshot.dnsName)
      return text("Turn on MagicDNS in the Tailscale admin console.", ADMIN_DNS);

    if (!this.options.tailscale.cli) return text("Install the Tailscale command-line tool to turn this on.");

    if (!snapshot.login && this.options.role === "desktop")
      return text("This computer is tagged in Tailscale, so Canopy can't check who opens it.");

    if (!snapshot.certDomains.includes(snapshot.dnsName))
      return text("Turn on HTTPS certificates in the Tailscale admin console.", ADMIN_DNS);

    return text("");
  }

  #policy(): FrontPolicy | undefined {
    const serve = this.#settings.serve;
    const snapshot = this.options.tailscale.snapshot;

    if (!this.#settings.enabled || !serve || !this.options.webOrigin || this.#reason().text) return undefined;

    return { host: serve.host, port: serve.port, login: snapshot.login || undefined, web: this.options.webOrigin };
  }

  async #apply() {
    if (!this.#settings.enabled) {
      await this.#remove();
      this.#state = "off";

      if (!this.#settings.serve) await this.#front.close();

      return;
    }

    if (this.#reason().text) {
      // The entry stays: Tailscale logged out or restarting brings it back as it was.
      this.#state = "unavailable";

      return;
    }

    try {
      await this.#add();
      this.#state = "on";
      this.#error = "";
    } catch (error) {
      this.#state = "error";
      this.#error = error instanceof Error ? error.message : "Tailscale Serve failed.";
      this.options.log?.(`tailscale: https over tailscale failed: ${this.#error}`);
    }
  }

  async #add() {
    const target = `http://127.0.0.1:${await this.#listen()}`;
    const config = await this.#config();
    const recorded = this.#settings.serve;
    const own = recorded && ownsEntry(config, recorded) ? recorded : undefined;

    // Changed or removed by someone else: Canopy forgets it and never touches it again.
    if (recorded && !own) await this.#save({ ...this.#settings, serve: null });
    const port = choosePort(config, own, this.#settings.port);
    const host = this.options.tailscale.snapshot.dnsName;

    if (own && own.port === port && own.host === host && own.target === target) return;

    if (own) {
      await this.#run(serveOffArgs(own.port));
      await this.#save({ ...this.#settings, serve: null });
    }

    await this.#run(serveOnArgs(port, target));
    await this.#save({ ...this.#settings, serve: { port, host, target } });
    this.options.log?.(`tailscale: https over tailscale on port ${port}`);
  }

  /** Removes Canopy's entry if it is still exactly Canopy's. Without a working Tailscale it waits for one. */
  async #remove() {
    const recorded = this.#settings.serve;

    if (!recorded || !this.options.tailscale.cli || this.options.tailscale.snapshot.state !== "connected") return;

    try {
      if (ownsEntry(await this.#config(), recorded)) await this.#run(serveOffArgs(recorded.port));
      await this.#save({ ...this.#settings, serve: null });
      this.#error = "";
    } catch (error) {
      this.#error = error instanceof Error ? error.message : "";
    }
  }

  /** The front on its kept port; a busy port moves it (the entry is then re-pointed). */
  async #listen() {
    if (this.#front.port) return this.#front.port;
    let port: number;

    try {
      port = this.#front.listen(this.#settings.frontPort ?? 0);
    } catch {
      port = this.#front.listen(0);
    }

    if (port !== this.#settings.frontPort) await this.#save({ ...this.#settings, frontPort: port });

    return port;
  }

  async #config() {
    const result = await this.#cli(serveStatusArgs());

    if (!result.ok) throw new Error(serveError(result.stderr));
    const config = parseServeConfig(result.stdout);

    if (!config) throw new Error("Tailscale Serve answered in a way Canopy doesn't understand.");

    return config;
  }

  async #run(args: string[]) {
    const result = await this.#cli(args);

    if (!result.ok) throw new Error(serveError(result.stderr || result.stdout));
  }

  #cli(args: string[]) {
    return this.options.tailscale.run(args);
  }

  async #save(settings: HttpsSettings) {
    this.#settings = settings;
    await saveHttpsSettings(this.options.store, settings);
  }

  #serial<A>(run: () => Promise<A>): Promise<A> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});

    return next;
  }
}
