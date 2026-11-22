ALTER TABLE network_access ADD COLUMN allowed_networks text[] NOT NULL
  DEFAULT '{tailscale,lan,public,vpn}'
  CHECK (cardinality(allowed_networks) BETWEEN 1 AND 4
    AND array_position(allowed_networks, NULL) IS NULL
    AND allowed_networks <@ ARRAY['tailscale', 'lan', 'public', 'vpn']::text[]);
