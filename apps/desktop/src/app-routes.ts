import { isDesktopRoute } from "@canopy/ui/desktop";

interface RouteTarget {
  send(channel: "canopy:open-route", path: string): void;
}

/** Keep the latest request until the application's route listener is ready. */
export class AppRoutes {
  #ready = new WeakSet<RouteTarget>();
  #pending = new WeakMap<RouteTarget, string>();

  open(target: RouteTarget, path: string): void {
    if (!isDesktopRoute(path)) return;
    this.#pending.set(target, path);
    this.#deliver(target);
  }

  ready(target: RouteTarget): void {
    this.#ready.add(target);
    this.#deliver(target);
  }

  loading(target: RouteTarget): void {
    this.#ready.delete(target);
  }

  #deliver(target: RouteTarget): void {
    const path = this.#pending.get(target);

    if (!path || !this.#ready.has(target)) return;
    this.#pending.delete(target);
    target.send("canopy:open-route", path);
  }
}
