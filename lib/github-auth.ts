const isGithubAuthError = (error: unknown) => {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return message.includes("github authentication failed")
    || message.includes("bad credentials");
};

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Whether an error from a GitHub call is transient (worth degrading gracefully /
 * serving stale rather than crashing): 5xx, rate limits (429), or a network /
 * timeout failure. Deliberately conservative so real errors (auth, 404, "Token
 * not found") are NOT swallowed.
 */
const isTransientGithubError = (error: unknown): boolean => {
  const anyError = error as any;
  const status = anyError?.status ?? anyError?.response?.status;
  if (typeof status === "number") {
    return status === 429 || status >= 500;
  }

  if (typeof anyError?.code === "string" && TRANSIENT_NETWORK_CODES.has(anyError.code)) {
    return true;
  }

  if (error instanceof Error) {
    const name = error.name ?? "";
    const message = error.message.toLowerCase();
    // undici surfaces fetch failures as a bare TypeError("fetch failed").
    if (name === "TypeError" && message.includes("fetch")) return true;
    if (
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("socket") ||
      message.includes("connection")
    ) {
      return true;
    }
  }

  return false;
};

export { isGithubAuthError, isTransientGithubError };
