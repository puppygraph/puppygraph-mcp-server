/**
 * JDBC URI helpers for the "localhost inside Docker" hint.
 *
 * PuppyGraph connects to a catalog's database from its own server. When it
 * runs in Docker, a JDBC URI with localhost points at the PuppyGraph
 * container, not at the machine the user (or agent) is on.
 */

export const DOCKER_HOST_ALIAS = "host.docker.internal";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

interface HostSpan {
  host: string;
  start: number;
  end: number;
}

// Host of the first server in a JDBC URI: jdbc:<sub>://host[:port]... (most
// drivers) or jdbc:oracle:thin:@host:port... ; null if there is none.
function hostSpan(uri: string): HostSpan | null {
  if (!/^jdbc:/i.test(uri)) return null;
  let start = uri.indexOf("://");
  if (start >= 0) {
    start += 3;
    // user:password@host
    const at = uri.indexOf("@", start);
    const slash = uri.slice(start).search(/[/;?]/);
    const authorityEnd = slash < 0 ? uri.length : start + slash;
    if (at >= 0 && at < authorityEnd) start = at + 1;
  } else {
    start = uri.indexOf("@");
    if (start < 0) return null;
    start += 1;
    if (uri.startsWith("//", start)) start += 2;
  }
  let end: number;
  if (uri[start] === "[") {
    end = uri.indexOf("]", start);
    if (end < 0) return null;
    end += 1;
  } else {
    // A backslash ends the host too: SQL Server names an instance as host\INSTANCE.
    const rest = uri.slice(start).search(/[:/;?,)\\]/);
    end = rest < 0 ? uri.length : start + rest;
  }
  const host = uri.slice(start, end);
  return host ? { host, start, end } : null;
}

export function jdbcHost(uri: string): string | null {
  return hostSpan(uri)?.host ?? null;
}

export function isLoopbackJdbcUri(uri: string | undefined | null): boolean {
  if (!uri) return false;
  const host = jdbcHost(uri);
  return host !== null && LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** The URI with its (loopback) host replaced by host.docker.internal. */
export function dockerHostJdbcUri(uri: string): string {
  const span = hostSpan(uri);
  if (!span) return uri;
  return uri.slice(0, span.start) + DOCKER_HOST_ALIAS + uri.slice(span.end);
}

// What PuppyGraph and the JDBC drivers say when they can't open a connection
// (PuppyGraph 1.x: "service (host:localhost port:5432) is not reachable").
const UNREACHABLE =
  /not reachable|unreachable|connection refused|refused|communications link failure|connect timed out|timed out|could not connect|unable to connect|connection attempt failed|no route to host/i;

export function looksUnreachable(message: string): boolean {
  return UNREACHABLE.test(message);
}

export const LOCALHOST_HINT =
  "PuppyGraph connects to the database from its own server, so 'localhost' there is the PuppyGraph host, not this machine. " +
  `If PuppyGraph runs in Docker and the database runs on the Docker host, retry with ${DOCKER_HOST_ALIAS} in place of localhost ` +
  `(on Linux the PuppyGraph container needs --add-host=${DOCKER_HOST_ALIAS}:host-gateway). ` +
  "If the database runs in another container, use that container's name on a shared Docker network.";
