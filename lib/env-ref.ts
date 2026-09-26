import { env } from "cloudflare:workers";

// `${NAME}` references in .pages.yml are controlled by anyone who can edit the
// repo, so only names meant for repo configs may be resolved. An open lookup
// would let a repo editor read any Worker secret (e.g. via a public snippet or
// a presigned URL pointed at their own endpoint).
const ALLOWED_PREFIXES = ["PAGES_STORAGE_", "PAGES_ANALYTICS_", "CF_BEACON_TOKEN_"];
const ALLOWED_NAMES = new Set([
  "CF_ACCOUNT_ID",
  "R2_ACCESS_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_KEY",
  "R2_SECRET_ACCESS_KEY",
  "R2_PUBLIC_URL",
]);

// Credential names only resolve in credential fields; anywhere else their
// value could end up in a URL or page the editor can read.
const CREDENTIAL_NAME = /(SECRET|ACCESS_KEY)/;

const ENV_PLACEHOLDER = /^\$\{([A-Z0-9_]+)\}$/;

export type EnvRefField = "credential" | "value";

export const isAllowedEnvRef = (name: string, field: EnvRefField = "value"): boolean => {
  if (!ALLOWED_NAMES.has(name) && !ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return false;
  }
  return field === "credential" || !CREDENTIAL_NAME.test(name);
};

/** The referenced name if `value` is a `${NAME}` placeholder, else null. */
export const parseEnvRef = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = ENV_PLACEHOLDER.exec(value.trim());
  return match ? match[1] : null;
};

/** Literal values pass through; placeholders resolve only for allowed names. */
export const resolveEnvRef = (
  value: string | undefined | null,
  field: EnvRefField = "value",
): string => {
  if (!value) return "";
  const name = parseEnvRef(value);
  if (name === null) return value;
  if (!isAllowedEnvRef(name, field)) return "";
  const resolved = (env as unknown as Record<string, unknown>)[name];
  return typeof resolved === "string" ? resolved : "";
};

export const collectEnvRefs = (values: unknown[]): string[] => {
  const seen = new Set<string>();
  for (const value of values) {
    const name = parseEnvRef(value);
    if (name) seen.add(name);
  }
  return Array.from(seen);
};

/** Presence per referenced name; disallowed names always report false. */
export const checkEnvRefsPresent = (names: string[]): Record<string, boolean> => {
  const e = env as unknown as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const name of names) {
    out[name] = isAllowedEnvRef(name, "credential") && typeof e[name] === "string" && e[name] !== "";
  }
  return out;
};
