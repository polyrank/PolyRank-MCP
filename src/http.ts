/**
 * The hosted Polyrank MCP server: Streamable HTTP (MCP_HTTP_ENABLED=1). Off by default; stdio is what ships on npm.
 *
 * SHAPE. Stateless: every POST is served by a fresh server instance from createPolyrankServer() (the SDK's
 * createMcpHandler, @modelcontextprotocol/server 2.4.0). Nothing is held between requests, so no session table, no
 * per-user timer, and any number of replicas behind nginx. 2026-07-28 clients get the modern per-request envelope;
 * 2025-era clients (an `initialize` handshake, which is what Claude, Cursor and the MCP Inspector send today) are
 * served by the SDK's stateless legacy leg. GET and DELETE (2025 session operations) answer 405.
 *
 * ENDPOINTS.
 *   POST /mcp         the 36 tools. Anonymous callers get the 17 free tools working and a "needs a key" answer from the
 *                     9 others; `Authorization: Bearer pk_live_…` (or pk_test_…) unlocks those with the caller's key.
 *   POST /mcp/public  the 17 free read-only tools only; an Authorization header is ignored and never forwarded. For a
 *                     listing that cannot pass a key (the Claude Connectors Directory takes OAuth or no auth).
 *   GET  /healthz     liveness: version and tool counts, no upstream call, no auth.
 *
 * AUTH. The key is the caller's, per request. The process env POLYRANK_API_KEY is NEVER used here (a hosted server
 * that fell back to it would hand one account's key to every anonymous caller). A malformed Authorization header is a
 * 401. A well-formed key is checked once against the API (GET /v1/stats/overview with the key; the API's key hook
 * answers 401 `invalid_api_key` for a bad one) and the answer cached by the key's SHA-256 fingerprint; if the API
 * cannot be reached the request goes on (fail-open), because the API re-checks the key on every tool call anyway: this
 * server grants nothing itself.
 *
 * LIMITS. The plan's per-key limits are the API's own (auth_api_key.ts: per-minute rate and monthly quota, keyed by
 * the API key) and apply unchanged, since every keyed tool call reaches the API with the caller's key. For anonymous
 * callers the API keys its limits on `cf-connecting-ip`; with MCP_FORWARD_CLIENT_IP=1 (set in compose, where the API
 * is reached on the internal network) this server forwards the caller's own address there, so each anonymous caller
 * keeps their own API bucket instead of all of them sharing this container's. In front of that, one-minute windows
 * here: per client address on every request (MCP_HTTP_ANON_PER_MIN, default 100, the nginx per-visitor rate on
 * api.polyrank.app; key-bearing requests get MCP_HTTP_KEY_PER_MIN per address instead, checked BEFORE the key is
 * looked up, so rotating made-up keys cannot buy unlimited upstream key checks), then per key fingerprint
 * (MCP_HTTP_KEY_PER_MIN, default 600, the highest plan's rpm; the API applies the caller's own plan rpm behind it).
 * In memory, per process: one replica is the design today; several replicas each enforce their own window.
 *
 * SECURITY (MCP transport spec, "Security Warning"). Host header validated against MCP_HTTP_ALLOWED_HOSTS (DNS
 * rebinding), Origin validated against MCP_HTTP_ALLOWED_ORIGINS (empty = any request carrying an Origin is refused;
 * server-to-server clients send none), body capped (MCP_HTTP_MAX_BODY_BYTES, 1 MiB), bound to 127.0.0.1 unless
 * MCP_HTTP_HOST says otherwise (the container binds 0.0.0.0 and compose publishes the port on 127.0.0.1 only).
 *
 * LOGS. One JSON line per request on stdout (pino-style numeric level): request id, path, status, ms, the JSON-RPC
 * method and tool name, the caller class, a 12-hex SHA-256 fingerprint of the key and of the client address. Never
 * the key, never the address, never a tool's arguments or result.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import {
  createPolyrankServer,
  DEFAULT_AGENT_BASE,
  DEFAULT_API_BASE,
  VERSION,
  type Toolset,
} from './index.js';

export const MCP_PATH = '/mcp';
export const PUBLIC_PATH = '/mcp/public';
export const HEALTH_PATH = '/healthz';
/** The tool counts per endpoint; tool_inventory.spec.ts pins them against what the server lists. */
export const TOOL_COUNTS = { all: 36, public: 17 } as const;

/** The API's own key format (apps/api/src/middleware/auth_api_key.ts PK_RE). */
const BEARER_RE = /^Bearer\s+(pk_(?:live|test)_[A-Z2-7]{22})$/i;

export interface HttpConfig {
  host: string;
  port: number;
  apiBase: string;
  agentBase: string;
  /** Hostnames (no port) the Host header may name. */
  allowedHosts: string[];
  /** Origin hostnames a browser request may come from. Empty = every request that carries an Origin is refused. */
  allowedOrigins: string[];
  /** Check a well-formed key against the API once (cached) and answer 401 for one it refuses. */
  verifyKeys: boolean;
  anonPerMin: number;
  keyPerMin: number;
  /** Forward the caller's address as cf-connecting-ip on upstream calls (only where the API is reached directly). */
  forwardClientIp: boolean;
  maxBodyBytes: number;
}

const list = (v: string | undefined, dflt: string[]): string[] =>
  v === undefined || v.trim() === ''
    ? dflt
    : v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
const int = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : dflt;
};

export function httpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  return {
    host: env['MCP_HTTP_HOST']?.trim() || '127.0.0.1',
    port: int(env['MCP_HTTP_PORT'], 3005),
    apiBase: env['POLYRANK_API_BASE']?.trim() || DEFAULT_API_BASE,
    agentBase: env['POLYRANK_AGENT_BASE']?.trim() || DEFAULT_AGENT_BASE,
    allowedHosts: list(env['MCP_HTTP_ALLOWED_HOSTS'], [
      'mcp.polyrank.app',
      'localhost',
      '127.0.0.1',
      '[::1]',
    ]),
    allowedOrigins: list(env['MCP_HTTP_ALLOWED_ORIGINS'], []),
    verifyKeys: env['MCP_HTTP_VERIFY_KEYS'] !== '0',
    anonPerMin: int(env['MCP_HTTP_ANON_PER_MIN'], 100),
    keyPerMin: int(env['MCP_HTTP_KEY_PER_MIN'], 600),
    forwardClientIp: env['MCP_FORWARD_CLIENT_IP'] === '1',
    maxBodyBytes: int(env['MCP_HTTP_MAX_BODY_BYTES'], 1024 * 1024),
  };
}

export const fingerprint = (s: string): string =>
  createHash('sha256').update(s).digest('hex').slice(0, 12);

/** A fixed one-minute window per caller. One Map, pruned when it grows; no timer. */
export class MinuteLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly maxEntries = 50_000) {}
  hit(
    key: string,
    limit: number,
    now: number,
  ): { ok: boolean; remaining: number; retryAfterSec: number } {
    const start = Math.floor(now / 60_000) * 60_000;
    let w = this.windows.get(key);
    if (w === undefined || w.start !== start) {
      if (w === undefined && this.windows.size >= this.maxEntries) this.prune(start);
      w = { start, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    const retryAfterSec = Math.max(1, Math.ceil((start + 60_000 - now) / 1000));
    return { ok: w.count <= limit, remaining: Math.max(0, limit - w.count), retryAfterSec };
  }
  private prune(currentStart: number): void {
    for (const [k, v] of this.windows) if (v.start !== currentStart) this.windows.delete(k);
    // Still full of current-minute callers: drop the oldest half rather than grow without bound.
    if (this.windows.size >= this.maxEntries) {
      let n = Math.floor(this.windows.size / 2);
      for (const k of this.windows.keys()) {
        if (n-- <= 0) break;
        this.windows.delete(k);
      }
    }
  }
  get size(): number {
    return this.windows.size;
  }
}

export type KeyCheck = 'valid' | 'invalid' | 'unknown';

/** The API's answer on a key, cached by fingerprint: 10 min for a valid key, 1 min for a refused one. */
export class KeyVerifier {
  private readonly cache = new Map<string, { result: 'valid' | 'invalid'; until: number }>();
  constructor(
    private readonly apiBase: string,
    private readonly doFetch: typeof fetch,
    private readonly maxEntries = 10_000,
  ) {}
  async check(token: string, now: number, extraHeaders: Record<string, string>): Promise<KeyCheck> {
    const fp = fingerprint(token);
    const hit = this.cache.get(fp);
    if (hit !== undefined && hit.until > now) return hit.result;
    let res: Response;
    try {
      res = await this.doFetch(`${this.apiBase}/v1/stats/overview`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': `polyrank-mcp/${VERSION} (http key check)`,
          ...extraHeaders,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return 'unknown';
    }
    let result: 'valid' | 'invalid' | null = null;
    if (res.status === 401) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      result = body?.error === 'invalid_api_key' ? 'invalid' : null;
    } else if (res.ok || res.status === 429) {
      // 429 comes after the key resolved (auth_api_key.ts checks the key, then the quota): the key exists.
      result = 'valid';
    }
    await res.body?.cancel().catch(() => undefined);
    if (result === null) return 'unknown';
    if (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(fp, { result, until: now + (result === 'valid' ? 600_000 : 60_000) });
    return result;
  }
}

/** Private, loopback and unique-local peers: the host nginx (through the Docker bridge) and sibling containers. */
const TRUSTED_PEERS = (() => {
  const b = new BlockList();
  b.addSubnet('127.0.0.0', 8, 'ipv4');
  b.addSubnet('10.0.0.0', 8, 'ipv4');
  b.addSubnet('172.16.0.0', 12, 'ipv4');
  b.addSubnet('192.168.0.0', 16, 'ipv4');
  b.addAddress('::1', 'ipv6');
  b.addSubnet('fc00::', 7, 'ipv6');
  return b;
})();

/**
 * The caller's address: Cloudflare's cf-connecting-ip when the peer is our own proxy (a private or loopback address),
 * the peer itself otherwise, so a client that reaches the port directly cannot choose its own bucket.
 */
export function clientAddress(req: Pick<IncomingMessage, 'headers' | 'socket'>): string {
  const raw = req.socket.remoteAddress ?? '';
  const peer = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw)?.[1] ?? raw;
  const family = isIP(peer);
  const trusted = family !== 0 && TRUSTED_PEERS.check(peer, family === 6 ? 'ipv6' : 'ipv4');
  const cf = req.headers['cf-connecting-ip'];
  if (trusted && typeof cf === 'string' && isIP(cf.trim()) !== 0) return cf.trim();
  return peer || 'unknown';
}

export type LogRecord = Record<string, unknown>;
const writeLog = (rec: LogRecord): void => {
  process.stdout.write(`${JSON.stringify(rec)}\n`);
};

export interface HttpDeps {
  fetch?: typeof fetch;
  log?: (rec: LogRecord) => void;
  now?: () => number;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += b.length;
    if (size > max) throw new BodyTooLarge();
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The JSON-RPC method(s) and tool name of a parsed body, for the request log. */
function describeRpc(body: unknown): { rpc?: string; tool?: string } {
  const msgs = Array.isArray(body) ? body : [body];
  const methods: string[] = [];
  let tool: string | undefined;
  for (const m of msgs) {
    if (m === null || typeof m !== 'object') continue;
    const method = (m as { method?: unknown }).method;
    if (typeof method === 'string') methods.push(method);
    const name = (m as { params?: { name?: unknown } }).params?.name;
    if (method === 'tools/call' && typeof name === 'string' && /^[a-z_]{1,64}$/.test(name))
      tool = name;
  }
  return {
    ...(methods.length ? { rpc: methods.join(',') } : {}),
    ...(tool ? { tool } : {}),
  };
}

export interface PolyrankHttpServer {
  server: Server;
  close: () => Promise<void>;
}

export function createHttpServer(cfg: HttpConfig, deps: HttpDeps = {}): PolyrankHttpServer {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? writeLog;
  const now = deps.now ?? Date.now;
  const limiter = new MinuteLimiter();
  const verifier = new KeyVerifier(cfg.apiBase, doFetch);
  const validateHost = hostHeaderValidation(cfg.allowedHosts);
  const validateOrigin = originValidation(cfg.allowedOrigins);

  const handlerFor = (toolset: Toolset) => {
    const handler = createMcpHandler(
      (ctx) => {
        const token = toolset === 'all' ? ctx.authInfo?.token : undefined;
        const ip = ctx.authInfo?.extra?.['clientIp'];
        return createPolyrankServer({
          transport: 'http',
          toolset,
          ...(token ? { apiKey: token } : {}),
          apiBase: cfg.apiBase,
          agentBase: cfg.agentBase,
          upstreamHeaders:
            cfg.forwardClientIp && typeof ip === 'string' ? { 'cf-connecting-ip': ip } : {},
          fetchImpl: doFetch,
        });
      },
      {
        maxRequestBodySize: cfg.maxBodyBytes,
        onerror: (err) =>
          log({
            level: 50,
            time: new Date(now()).toISOString(),
            msg: 'mcp_handler_error',
            err: err.message,
          }),
      },
    );
    return {
      handler,
      node: toNodeHandler(handler, {
        maxRequestBodySize: cfg.maxBodyBytes,
        onerror: (err) =>
          log({
            level: 50,
            time: new Date(now()).toISOString(),
            msg: 'mcp_adapter_error',
            err: err.message,
          }),
      }),
    };
  };
  const handlers = { all: handlerFor('all'), public: handlerFor('public') };

  async function handle(req: IncomingMessage, res: ServerResponse, rec: LogRecord): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    rec['path'] = path;
    const method = req.method ?? 'GET';

    if (path === HEALTH_PATH) {
      if (method !== 'GET' && method !== 'HEAD')
        return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      return sendJson(res, 200, {
        status: 'ok',
        service: 'polyrank-mcp',
        version: VERSION,
        transport: 'streamable-http',
        endpoints: { [MCP_PATH]: TOOL_COUNTS.all, [PUBLIC_PATH]: TOOL_COUNTS.public },
      });
    }
    const toolset: Toolset | null =
      path === MCP_PATH ? 'all' : path === PUBLIC_PATH ? 'public' : null;
    if (toolset === null)
      return sendJson(res, 404, {
        error: 'not_found',
        message: `The MCP endpoints are POST ${MCP_PATH} and POST ${PUBLIC_PATH}. Docs: https://docs.polyrank.app/mcp`,
      });
    rec['toolset'] = toolset;

    if (!validateHost(req, res)) return void (rec['refused'] = 'host');
    if (!validateOrigin(req, res)) return void (rec['refused'] = 'origin');
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      // Only an allow-listed origin gets here (originValidation refused the rest).
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate, Retry-After',
      );
    }
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
        'Access-Control-Max-Age': '600',
      });
      return void res.end();
    }

    const ip = clientAddress(req);
    rec['ip_fp'] = fingerprint(ip);
    const authz = req.headers.authorization;
    const bearing = toolset === 'all' && typeof authz === 'string' && authz.trim() !== '';
    // Per address first, before any key is looked at: rotating made-up keys must not buy unlimited upstream checks.
    const tooMany = (limit: number, per: string, retryAfterSec: number) => {
      rec['refused'] = 'rate';
      sendJson(
        res,
        429,
        rpcError(
          -32000,
          `Rate limited: ${limit} requests a minute per ${per} on this server. Retry in ${retryAfterSec} s.`,
        ),
        { 'Retry-After': String(retryAfterSec) },
      );
    };
    const ipLimit = bearing ? cfg.keyPerMin : cfg.anonPerMin;
    const ipHit = limiter.hit(`${bearing ? 'ipk' : 'ip'}:${ip}`, ipLimit, now());
    res.setHeader('X-RateLimit-Limit', String(ipLimit));
    res.setHeader('X-RateLimit-Remaining', String(ipHit.remaining));
    if (!ipHit.ok) return tooMany(ipLimit, 'caller', ipHit.retryAfterSec);

    let token: string | undefined;
    if (bearing) {
      const m = BEARER_RE.exec(authz!.trim());
      if (m === null) {
        rec['refused'] = 'auth_format';
        return sendJson(
          res,
          401,
          {
            error: 'invalid_token',
            message:
              'Send a Polyrank API key as "Authorization: Bearer pk_live_…" (create one at https://polyrank.app/api-keys), or no Authorization header for the free tools.',
          },
          {
            'WWW-Authenticate':
              'Bearer realm="polyrank", error="invalid_token", error_description="expected a pk_live_ or pk_test_ API key"',
          },
        );
      }
      token = m[1]!;
      rec['key_fp'] = fingerprint(token);
      if (cfg.verifyKeys) {
        const check = await verifier.check(
          token,
          now(),
          cfg.forwardClientIp ? { 'cf-connecting-ip': ip } : {},
        );
        rec['key_check'] = check;
        if (check === 'invalid') {
          rec['refused'] = 'auth_key';
          return sendJson(
            res,
            401,
            {
              error: 'invalid_api_key',
              message:
                'Polyrank did not accept this API key (revoked or mistyped). Create or copy a key at https://polyrank.app/api-keys.',
            },
            {
              'WWW-Authenticate':
                'Bearer realm="polyrank", error="invalid_token", error_description="the API key was not accepted"',
            },
          );
        }
      }
    }
    rec['caller'] = token ? 'key' : 'anon';

    if (token !== undefined) {
      const keyHit = limiter.hit(`key:${fingerprint(token)}`, cfg.keyPerMin, now());
      res.setHeader('X-RateLimit-Limit', String(cfg.keyPerMin));
      res.setHeader('X-RateLimit-Remaining', String(keyHit.remaining));
      if (!keyHit.ok) return tooMany(cfg.keyPerMin, 'API key', keyHit.retryAfterSec);
    }

    let parsedBody: unknown;
    if (method === 'POST') {
      let raw: string;
      try {
        raw = await readBody(req, cfg.maxBodyBytes);
      } catch (e) {
        if (e instanceof BodyTooLarge) {
          rec['refused'] = 'body_size';
          return sendJson(
            res,
            413,
            rpcError(-32600, `Request body over ${cfg.maxBodyBytes} bytes.`),
          );
        }
        throw e;
      }
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        rec['refused'] = 'parse';
        return sendJson(res, 400, rpcError(-32700, 'Parse error: the body is not JSON.'));
      }
      Object.assign(rec, describeRpc(parsedBody));
    }

    const auth: AuthInfo = {
      token: token ?? '',
      clientId: token ? `key:${fingerprint(token)}` : 'anonymous',
      scopes: [],
      extra: { clientIp: ip },
    };
    (req as IncomingMessage & { auth?: AuthInfo }).auth = auth;
    // SSE answers must not sit in nginx's buffer (the legacy leg streams when the client accepts it).
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-store');
    await handlers[toolset].node(
      req as unknown as Parameters<(typeof handlers)['all']['node']>[0],
      res as unknown as Parameters<(typeof handlers)['all']['node']>[1],
      ...(method === 'POST' ? [parsedBody] : []),
    );
  }

  const server = createServer((req, res) => {
    const t0 = performance.now();
    const reqId = randomUUID();
    res.setHeader('X-Request-Id', reqId);
    const rec: LogRecord = { msg: 'mcp_request', req_id: reqId, method: req.method };
    res.on('finish', () => {
      if (rec['path'] === HEALTH_PATH && res.statusCode === 200) return; // the healthcheck runs every 10 s
      log({
        level: res.statusCode >= 500 ? 50 : res.statusCode >= 400 ? 40 : 30,
        time: new Date(now()).toISOString(),
        service: 'polyrank-mcp',
        ...rec,
        status: res.statusCode,
        ms: Math.round(performance.now() - t0),
      });
    });
    handle(req, res, rec).catch((err: unknown) => {
      rec['err'] = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, rpcError(-32603, 'Internal error in the Polyrank MCP server.'));
    });
  });
  // Behind nginx (keepalive upstream): keep idle sockets longer than nginx does, and bound slow clients.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 120_000;

  return {
    server,
    close: async () => {
      await Promise.all([handlers.all.handler.close(), handlers.public.handler.close()]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The container entry (index.ts main with MCP_HTTP_ENABLED=1). */
export async function startHttpServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PolyrankHttpServer> {
  const cfg = httpConfigFromEnv(env);
  const started = createHttpServer(cfg);
  const base = { service: 'polyrank-mcp', time: new Date().toISOString() };
  if (env['POLYRANK_API_KEY'])
    writeLog({
      ...base,
      level: 40,
      msg: 'POLYRANK_API_KEY is set in this process: the HTTP transport ignores it (each caller sends their own key).',
    });
  await new Promise<void>((resolve, reject) => {
    started.server.once('error', reject);
    started.server.listen(cfg.port, cfg.host, () => resolve());
  });
  writeLog({
    ...base,
    level: 30,
    msg: `Polyrank MCP server ${VERSION} running (streamable-http) on ${cfg.host}:${cfg.port} → ${cfg.apiBase}`,
    endpoints: [MCP_PATH, PUBLIC_PATH, HEALTH_PATH],
    allowed_hosts: cfg.allowedHosts,
    allowed_origins: cfg.allowedOrigins,
    verify_keys: cfg.verifyKeys,
    anon_per_min: cfg.anonPerMin,
    key_per_min: cfg.keyPerMin,
    forward_client_ip: cfg.forwardClientIp,
  });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    writeLog({
      service: 'polyrank-mcp',
      time: new Date().toISOString(),
      level: 30,
      msg: `${signal}: closing`,
    });
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    void started.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  return started;
}
