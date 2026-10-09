/**
 * Credential masking for everything the setup tools return or log.
 *
 * Responses about catalogs and schemas can contain the credentials that were
 * sent in the request, so the MCP server never relays a response body as-is.
 * Results go through `maskSecrets`, and any text that may quote a request
 * (error messages) goes through `scrubText` with the secrets that were sent.
 */

export const MASK = "******";

// Field names that hold credentials in catalog definitions: jdbc.password,
// jdbcPassword, accessKey/secretKey, client_secret, sasToken, token, ...
const SECRET_KEY_PATTERN =
  /pass(word)?$|secret|token|credential|private.?key|access.?key|api.?key|sas$/i;

// Secrets shorter than this are not scrubbed from free text: replacing every
// "a" or "pw" in a message would make it unreadable and protect little.
const MIN_SCRUB_LENGTH = 4;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Removes credentials embedded in a JDBC or HTTP URI: user:password@ userinfo
 * and password/secret/token query or property parameters.
 */
export function redactUri(uri: string): string {
  return uri
    .replace(/(\/\/)([^/@\s]+)@/g, (_match, slashes: string, userinfo: string) => {
      const user = userinfo.split(":")[0];
      return userinfo.includes(":") ? `${slashes}${user}:${MASK}@` : `${slashes}${userinfo}@`;
    })
    .replace(
      /([?&;](?:[A-Za-z_]*(?:password|pwd|secret|token|private_?key[A-Za-z_]*)))=([^&;\s"]*)/gi,
      (_match, key: string) => `${key}=${MASK}`,
    );
}

/**
 * Returns a deep copy of `value` with every credential field masked, URIs
 * redacted and the given literal secrets removed from all strings.
 */
export function maskSecrets<T>(value: T, secrets: readonly string[] = []): T {
  return maskValue(value, undefined, secrets) as T;
}

function maskValue(
  value: unknown,
  key: string | undefined,
  secrets: readonly string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, undefined, secrets));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        maskValue(v, k, secrets),
      ]),
    );
  }
  if (typeof value === "string") {
    if (key !== undefined && isSecretKey(key) && value !== "") {
      return MASK;
    }
    return scrubText(redactUri(value), secrets);
  }
  return value;
}

/** Replaces every occurrence of the given secrets in free text. */
export function scrubText(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SCRUB_LENGTH) {
      result = result.split(secret).join(MASK);
    }
  }
  return result;
}

/**
 * Collects the literal secret values in a request payload (catalog
 * definitions, schemas with embedded catalogs), so they can be scrubbed from
 * whatever comes back.
 */
export function collectSecrets(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSecrets(item, found));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && isSecretKey(k) && v !== "" && v !== MASK) {
        found.push(v);
      } else {
        collectSecrets(v, found);
      }
    }
  }
  return found;
}
