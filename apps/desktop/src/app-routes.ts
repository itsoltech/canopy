import { isDesktopRoute } from "@canopy/ui/desktop";

interface RouteTarget {
  send(channel: "canopy:open-route", path: string, keyboard?: boolean): void;
}

/** Keep the latest request until the application's route listener is ready. */
export class AppRoutes {
  #ready = new WeakSet<RouteTarget>();
  #pending = new WeakMap<RouteTarget, { path: string; keyboard: boolean | undefined }>();

  open(target: RouteTarget, path: string, keyboard?: boolean): void {
    if (!isDesktopRoute(path)) return;
    this.#pending.set(target, { path, keyboard });
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
    const route = this.#pending.get(target);

    if (!route || !this.#ready.has(target)) return;
    this.#pending.delete(target);
    target.send("canopy:open-route", route.path, route.keyboard);
  }
}
