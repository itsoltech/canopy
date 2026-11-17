// Environment reports may contain 128 MiB of JSON; jsonb formatting and the
// surrounding DataRow fields also count toward the PostgreSQL protocol limit.
export const POSTGRES_MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
