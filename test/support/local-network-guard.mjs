import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const enabled = process.env.INSIGHT_TEST_NETWORK === "local-only";
const localHosts = new Set(["127.0.0.1", "::1", "localhost"]);

function normalizeHost(host) {
  return String(host ?? "localhost")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
}

function assertLocalHost(host, protocol = "network") {
  const normalized = normalizeHost(host);
  if (!localHosts.has(normalized)) {
    throw new Error(
      `CI network policy blocked ${protocol} access to ${normalized}; tests may use local services only.`,
    );
  }
}

function requestHost(input) {
  if (input instanceof URL) return input.hostname;
  if (typeof input === "string") {
    if (input.startsWith("/")) return "localhost";
    return new URL(input).hostname;
  }
  return input?.hostname ?? input?.host;
}

function netHost(args) {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    if (first.path) return "localhost";
    return first.host;
  }
  return typeof args[1] === "string" ? args[1] : "localhost";
}

if (enabled) {
  const originalFetch = globalThis.fetch;
  if (originalFetch) {
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input);
      assertLocalHost(url.hostname, url.protocol);
      return originalFetch(input, init);
    };
  }

  for (const transport of [http, https]) {
    for (const method of ["request", "get"]) {
      const original = transport[method];
      transport[method] = function localOnlyRequest(...args) {
        assertLocalHost(requestHost(args[0]), `${transport === https ? "https" : "http"}:`);
        return original.apply(this, args);
      };
    }
  }

  for (const method of ["connect", "createConnection"]) {
    const original = net[method];
    net[method] = function localOnlyConnection(...args) {
      assertLocalHost(netHost(args), "tcp");
      return original.apply(this, args);
    };
  }

  const originalLookup = dns.lookup;
  dns.lookup = function localOnlyLookup(hostname, ...args) {
    assertLocalHost(hostname, "dns");
    return originalLookup.call(this, hostname, ...args);
  };
}
