/** Between the gateway and its embedded web child (process.ts ↔ serve.ts). */
export const WEB_INSTANCE_HEADER = "x-canopy-web-instance";

/** IPC: the Host names learned at runtime (Tailscale MagicDNS), `{ type, hosts: string[] }`. */
export const WEB_HOSTS_MESSAGE = "canopy:web-hosts";
