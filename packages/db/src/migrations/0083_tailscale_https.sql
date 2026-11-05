-- HTTPS over Tailscale (docs/tailscale.md): the switch, the chosen HTTPS port (NULL = automatic), the port of
-- the local front the Serve entry points at, and exactly the Serve entry Canopy added ({port, host, target}),
-- so turning it off removes only that entry.
ALTER TABLE network_access
  ADD COLUMN tailscale_https boolean NOT NULL DEFAULT false,
  ADD COLUMN tailscale_https_port integer CHECK (tailscale_https_port BETWEEN 1 AND 65535),
  ADD COLUMN tailscale_front_port integer CHECK (tailscale_front_port BETWEEN 1 AND 65535),
  ADD COLUMN tailscale_serve jsonb CHECK (tailscale_serve IS NULL OR jsonb_typeof(tailscale_serve) = 'object');
