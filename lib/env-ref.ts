import { env } from "cloudflare:workers";

// `${NAME}` references in .pages.yml are controlled by anyone who can edit the
// repo, so only names meant for repo configs may be resolved. An open lookup
// would let a repo editor read any Worker secret (e.g. via a public snippet or
// a presigned URL pointed at their own endpoint).
const ALLOWED_PREFIXES = ["PAGES_STORAGE_", "PAGES_ANALYTICS_"];
const ALLOWED_NAMES = new Set(["R2_ACCESS_KEY", "R2_SECRET_KEY", "R2_PUBLIC_URL"]);

const ENV_PLACEHOLDER = /^\$\{([A-Z0-9_]+)\}$/;

export const isAllowedEnvRef = (name: string): boolean =>
  ALLOWED_NAMES.has(name) || ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));

/** The referenced name if `value` is a `${NAME}` placeholder, else null. */
export const parseEnvRef = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = ENV_PLACEHOLDER.exec(value.trim());
  return match ? match[1] : null;
};

/** Literal values pass through; placeholders resolve only for allowed names. */
export const resolveEnvRef = (value: string | undefined | null): string => {
  if (!value) return "";
  const name = parseEnvRef(value);
  if (name === null) return value;
  if (!isAllowedEnvRef(name)) return "";
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
    out[name] = isAllowedEnvRef(name) && typeof e[name] === "string" && e[name] !== "";
  }
  return out;
};
