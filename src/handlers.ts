import { ValueError } from '@maxmind/geoip2-node';
import { timingSafeEqual } from 'node:crypto';
import { AddressNotFoundError, IpLookupService } from './ipLookupService.js';
import type { Logger } from './logger.js';

export type IpLookupRouteDeps = {
  lookupService: IpLookupService;
  logger: Logger;
  apiKey: string;
};

function providedApiKeyFromRequest(req: Request): string | undefined {
  const x = req.headers.get('x-api-key')?.trim();
  if (x) return x;
  const auth = req.headers.get('authorization');
  if (!auth) return undefined;
  const m = /^Bearer\s+(\S+)/i.exec(auth.trim());
  return m?.[1]?.trim();
}

function apiKeyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `401` if the request does not carry the configured API key. */
export function requireApiKey(req: Request, deps: IpLookupRouteDeps): Response | null {
  const provided = providedApiKeyFromRequest(req);
  if (!provided) {
    return Response.json({ error: 'missing api key' }, { status: 401 });
  }
  if (!apiKeyMatches(provided, deps.apiKey)) {
    return Response.json({ error: 'invalid api key' }, { status: 401 });
  }
  return null;
}

/** Minimal type for {@link Bun.serve} `server` (only `requestIP` is used). */
export type RequestIpSource = {
  requestIP(request: Request): { address: string; port: number } | null;
};

function stripIpv4Port(value: string): string {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):[0-9]+$/.exec(value.trim());
  if (m) return m[1]!;
  return value.trim();
}

function normalizeForwardedIp(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('[') && s.includes(']')) {
    s = s.slice(1, s.indexOf(']'));
    return s;
  }
  return stripIpv4Port(s);
}

/**
 * Client IP for lookups: common proxy headers first, otherwise the socket address.
 */
export function clientIpFromRequest(
  req: Request,
  server: RequestIpSource,
): string | undefined {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0];
    if (first) {
      const ip = normalizeForwardedIp(first);
      if (ip.length > 0) return ip;
    }
  }
  for (const h of ['cf-connecting-ip', 'true-client-ip', 'x-real-ip'] as const) {
    const v = req.headers.get(h);
    if (v) {
      const ip = normalizeForwardedIp(v);
      if (ip.length > 0) return ip;
    }
  }
  return server.requestIP(req)?.address;
}

/**
 * JSON response body for a resolved IP (from query param or client IP).
 */
export function ipLookupResponse(deps: IpLookupRouteDeps, ip: string): Response {
  if (!deps.lookupService.isLoaded()) {
    return Response.json({ error: 'database not ready' }, { status: 503 });
  }
  try {
    return Response.json(deps.lookupService.lookup(ip));
  } catch (e) {
    if (e instanceof AddressNotFoundError) {
      return Response.json({ error: 'address not found', ip }, { status: 404 });
    }
    if (e instanceof ValueError) {
      return Response.json(
        { error: 'invalid ip', ip, message: e.message },
        { status: 400 },
      );
    }
    deps.logger.error('ip lookup failed', { err: e, ip });
    return Response.json({ error: 'lookup failed' }, { status: 500 });
  }
}

export function handleIpLookupFromQuery(req: Request, deps: IpLookupRouteDeps): Response {
  const auth = requireApiKey(req, deps);
  if (auth) return auth;
  const ip = new URL(req.url).searchParams.get('ip')?.trim();
  if (!ip) {
    return Response.json({ error: 'query parameter ip is required' }, { status: 400 });
  }
  return ipLookupResponse(deps, ip);
}

export function handleIpLookupFromClient(
  req: Request,
  server: RequestIpSource,
  deps: IpLookupRouteDeps,
): Response {
  const auth = requireApiKey(req, deps);
  if (auth) return auth;
  const ip = clientIpFromRequest(req, server);
  if (!ip) {
    return Response.json({ error: 'could not determine client ip' }, { status: 400 });
  }
  return ipLookupResponse(deps, ip);
}
