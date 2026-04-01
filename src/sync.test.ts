import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Logger } from './logger.js';
import {
  type MaxMindSyncDeps,
  type MaxMindSyncInput,
  basicAuthHeader,
  buildDownloadPermalink,
  createDefaultMaxMindSyncDeps,
  LOCAL_MAX_AGE_MS,
  runMaxMindSync,
  shouldDownload,
} from './sync.js';

const FIX_RUN = '00000000-0000-4000-8000-000000000001';

function testLogger(): Logger {
  return new Logger({ service: 'ip-lookup-api-test' });
}

function fmtConsoleArgs(args: unknown[]): string {
  return args
    .map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x)))
    .join(' ');
}

function stubConsole(): {
  restore: () => void;
  logs: string[];
  warns: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const oLog = console.log;
  const oWarn = console.warn;
  const oErr = console.error;
  console.log = (...a: unknown[]) => logs.push(fmtConsoleArgs(a));
  console.warn = (...a: unknown[]) => warns.push(fmtConsoleArgs(a));
  console.error = (...a: unknown[]) => errors.push(fmtConsoleArgs(a));
  return {
    restore: () => {
      console.log = oLog;
      console.warn = oWarn;
      console.error = oErr;
    },
    logs,
    warns,
    errors,
  };
}

function isMetadataRangeProbe(init: RequestInit | undefined): boolean {
  if (init?.method !== 'GET') return false;
  const h = init.headers;
  if (!h || typeof h !== 'object') return false;
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    return h.get('Range') === 'bytes=0-0';
  }
  return (h as Record<string, string>).Range === 'bytes=0-0';
}

describe('buildDownloadPermalink', () => {
  test('uses explicit downloadUrl', () => {
    expect(
      buildDownloadPermalink({
        downloadUrl: 'https://example.com/db.tar.gz',
        editionIds: 'GeoLite2-City',
      }),
    ).toBe('https://example.com/db.tar.gz');
  });

  test('builds URL from first edition', () => {
    expect(
      buildDownloadPermalink({
        editionIds: ' GeoLite2-City , GeoLite2-ASN ',
      }),
    ).toBe(
      'https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz',
    );
  });

  test('splits edition IDs on comma or whitespace', () => {
    expect(
      buildDownloadPermalink({
        editionIds: 'GeoLite2-ASN GeoLite2-City GeoLite2-Country',
      }),
    ).toBe(
      'https://download.maxmind.com/geoip/databases/GeoLite2-ASN/download?suffix=tar.gz',
    );
  });

  test('returns undefined without source', () => {
    expect(buildDownloadPermalink({})).toBeUndefined();
  });
});

describe('basicAuthHeader', () => {
  test('encodes account:key as Basic', () => {
    expect(basicAuthHeader('123', 'secret')).toBe(
      `Basic ${Buffer.from('123:secret', 'utf8').toString('base64')}`,
    );
  });
});

describe('shouldDownload', () => {
  const t0 = 1_000_000;

  test('true when no local file', () => {
    expect(shouldDownload(undefined, new Date(t0 + 1000), t0)).toBe(true);
  });

  test('false when remote not newer than local mtime', () => {
    const localM = t0 + 5000;
    expect(shouldDownload(localM, new Date(t0), t0)).toBe(false);
    expect(shouldDownload(localM, new Date(localM - 1000), t0)).toBe(false);
  });

  test('true when remote newer than local mtime', () => {
    const localM = t0;
    expect(shouldDownload(localM, new Date(t0 + 10_000), t0)).toBe(true);
  });

  test('2000 ms tolerance for Last-Modified', () => {
    const localM = t0 + 1000;
    expect(shouldDownload(localM, new Date(t0 + 1000), t0)).toBe(false);
    // Download only when remote > localMtime + 2000 ms
    expect(shouldDownload(localM, new Date(t0 + 3001), t0)).toBe(true);
  });

  test('without remote Last-Modified: stale only after one week', () => {
    const now = 1_000_000_000_000;
    const fresh = now - LOCAL_MAX_AGE_MS + 1000;
    expect(shouldDownload(fresh, null, now)).toBe(false);

    const stale = now - LOCAL_MAX_AGE_MS - 1000;
    expect(shouldDownload(stale, null, now)).toBe(true);
  });
});

describe('runMaxMindSync', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ip-lookup-sync-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  function baseInput(over: Partial<MaxMindSyncInput> = {}): MaxMindSyncInput {
    return {
      accountId: 'acc',
      licenseKey: 'key',
      dataDir,
      mmdbFilename: 'GeoLite2-City.mmdb',
      editionIds: 'GeoLite2-City',
      ...over,
    };
  }

  function mockDeps(over: Record<string, unknown>): MaxMindSyncDeps {
    const real = createDefaultMaxMindSyncDeps();
    return { ...real, ...over } as MaxMindSyncDeps;
  }

  test('skips without credentials (no fetch)', async () => {
    let fetched = 0;
    const c = stubConsole();
    try {
      await runMaxMindSync(
        mockDeps({
          fetch: () => {
            fetched++;
            return Promise.resolve(new Response());
          },
        }),
        baseInput({ accountId: '', licenseKey: '' }),
        { logger: testLogger(), runId: FIX_RUN },
      );
    } finally {
      c.restore();
    }
    expect(fetched).toBe(0);
    expect(c.warns.length).toBe(1);
    expect(c.warns[0]).toContain(FIX_RUN);
    expect(c.warns[0]).toContain('skip: missing credentials');
  });

  test('generates a UUID runId when options omitted', async () => {
    const c = stubConsole();
    try {
      await runMaxMindSync(
        mockDeps({ fetch: () => Promise.resolve(new Response()) }),
        baseInput({ accountId: '', licenseKey: '' }),
        { logger: testLogger() },
      );
    } finally {
      c.restore();
    }
    const parsed = JSON.parse(c.warns[0] ?? '{}') as { runId?: string };
    expect(parsed.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test('skips without download URL', async () => {
    let fetched = 0;
    const c = stubConsole();
    try {
      await runMaxMindSync(
        mockDeps({
          fetch: () => {
            fetched++;
            return Promise.resolve(new Response());
          },
        }),
        baseInput({ editionIds: undefined, downloadUrl: undefined }),
        { logger: testLogger(), runId: FIX_RUN },
      );
    } finally {
      c.restore();
    }
    expect(fetched).toBe(0);
    expect(c.warns.length).toBe(1);
    expect(c.warns[0]).toContain(FIX_RUN);
    expect(c.warns[0]).toContain('skip: no download URL');
  });

  test('no fetch when local DB younger than 7 days', async () => {
    const localPath = join(dataDir, 'GeoLite2-City.mmdb');
    const mtime = new Date('2024-06-01T12:00:00Z').getTime();
    await writeFile(localPath, 'x', 'utf8');
    await utimes(localPath, new Date(mtime), new Date(mtime));

    let fetched = 0;
    const c = stubConsole();
    try {
      await runMaxMindSync(
        mockDeps({
          now: () => mtime + 60_000,
          fetch: () => {
            fetched++;
            return Promise.resolve(new Response());
          },
        }),
        baseInput(),
        { logger: testLogger(), runId: FIX_RUN },
      );
    } finally {
      c.restore();
    }

    expect(fetched).toBe(0);
    expect(
      c.logs.some(
        (l) =>
          l.includes(FIX_RUN) &&
          l.includes('skip sync: local database younger than 7 days'),
      ),
    ).toBe(true);
  });

  test('throws on metadata probe failure without local DB', async () => {
    await expect(
      runMaxMindSync(
        mockDeps({
          fetch: () => Promise.resolve(new Response(null, { status: 401 })),
        }),
        baseInput(),
        { logger: testLogger(), runId: FIX_RUN },
      ),
    ).rejects.toThrow(/metadata probe failed.*401/s);
  });

  test('swallows metadata probe failure when local DB exists', async () => {
    const localPath = join(dataDir, 'GeoLite2-City.mmdb');
    await writeFile(localPath, 'x', 'utf8');
    const staleMtime = new Date(Date.now() - LOCAL_MAX_AGE_MS - 60_000);
    await utimes(localPath, staleMtime, staleMtime);

    const c = stubConsole();
    try {
      await runMaxMindSync(
        mockDeps({
          fetch: () => Promise.resolve(new Response(null, { status: 500 })),
        }),
        baseInput(),
        { logger: testLogger(), runId: FIX_RUN },
      );
    } finally {
      c.restore();
    }
    expect(c.errors.length).toBe(1);
    expect(c.errors[0]).toContain(FIX_RUN);
    expect(c.errors[0]).toContain('metadata probe failed');
  });

  test('no full download GET when Last-Modified not newer', async () => {
    const localPath = join(dataDir, 'GeoLite2-City.mmdb');
    const mtime = new Date('2024-06-01T12:00:00Z').getTime();
    await writeFile(localPath, 'old', 'utf8');
    await utimes(localPath, new Date(mtime), new Date(mtime));

    const methods: string[] = [];
    const c = stubConsole();
    try {
      await runMaxMindSync(
        mockDeps({
          now: () => mtime + LOCAL_MAX_AGE_MS + 1000,
          fetch: (_url: RequestInfo | URL, init?: RequestInit) => {
            methods.push(init?.method ?? 'GET');
            if (isMetadataRangeProbe(init)) {
              return Promise.resolve(
                new Response(null, {
                  status: 206,
                  headers: {
                    'last-modified': new Date(mtime).toUTCString(),
                    'content-range': 'bytes 0-0/999999',
                    'content-length': '1',
                  },
                }),
              );
            }
            return Promise.resolve(new Response('unexpected'));
          },
        }),
        baseInput(),
        { logger: testLogger(), runId: FIX_RUN },
      );
    } finally {
      c.restore();
    }

    expect(methods).toEqual(['GET']);
    expect(await readFile(localPath, 'utf8')).toBe('old');
    expect(c.logs.length).toBe(1);
    expect(c.logs[0]).toContain(FIX_RUN);
    expect(c.logs[0]).toContain('up to date');
  });

  test('metadata probe strips auth after redirect to presigned URL', async () => {
    const presigned = 'https://mm-prod-geoip-databases.example/r2-path?sig=abc';
    const requests: { url: string; auth?: string }[] = [];
    const remoteLm = new Date('2024-06-01T12:00:00Z');
    const localPath = join(dataDir, 'GeoLite2-City.mmdb');
    await writeFile(localPath, 'x', 'utf8');
    await utimes(localPath, remoteLm, remoteLm);

    const c = stubConsole();
    try {
      await runMaxMindSync(
        mockDeps({
          now: () => remoteLm.getTime() + LOCAL_MAX_AGE_MS + 1000,
          fetch: (reqUrl: RequestInfo | URL, init?: RequestInit) => {
            const h = init?.headers;
            const auth =
              typeof h === 'object' &&
              h !== null &&
              !('append' in h) &&
              'Authorization' in h
                ? String((h as Record<string, string>).Authorization)
                : undefined;
            const urlStr =
              typeof reqUrl === 'string'
                ? reqUrl
                : reqUrl instanceof URL
                  ? reqUrl.href
                  : reqUrl.url;
            requests.push({ url: urlStr, auth });

            if (requests.length === 1) {
              return Promise.resolve(
                new Response(null, {
                  status: 302,
                  headers: { Location: presigned },
                }),
              );
            }
            return Promise.resolve(
              new Response(null, {
                status: 206,
                headers: {
                  'last-modified': remoteLm.toUTCString(),
                  'content-range': 'bytes 0-0/1000',
                  'content-length': '1',
                },
              }),
            );
          },
        }),
        baseInput(),
        { logger: testLogger(), runId: FIX_RUN },
      );
    } finally {
      c.restore();
    }

    expect(requests).toHaveLength(2);
    const [req0, req1] = requests;
    expect(req0?.auth).toBeDefined();
    expect(req1?.url).toBe(presigned);
    expect(req1?.auth).toBeUndefined();
    expect(c.logs.some((l) => l.includes(FIX_RUN) && l.includes('up to date'))).toBe(
      true,
    );
  });

  test('GET and install when no local file', async () => {
    const remoteLm = new Date('2024-07-15T08:00:00Z');
    const methods: string[] = [];

    const c = stubConsole();
    try {
      await runMaxMindSync(
        mockDeps({
          now: () => remoteLm.getTime(),
          fetch: (_url: RequestInfo | URL, init?: RequestInit) => {
            methods.push(init?.method ?? 'GET');
            if (isMetadataRangeProbe(init)) {
              return Promise.resolve(
                new Response(null, {
                  status: 206,
                  headers: {
                    'last-modified': remoteLm.toUTCString(),
                    'content-range': 'bytes 0-0/999',
                    'content-length': '1',
                  },
                }),
              );
            }
            return Promise.resolve(new Response(new Uint8Array([0, 1, 2])));
          },
          extractTarGz: async (_archivePath: string, destDir: string) => {
            const nested = join(destDir, 'nested');
            await mkdir(nested, { recursive: true });
            await writeFile(join(nested, 'GeoLite2-City.mmdb'), 'mmdb-bytes', 'utf8');
          },
        }),
        baseInput(),
        { logger: testLogger(), runId: FIX_RUN },
      );
    } finally {
      c.restore();
    }

    expect(methods).toEqual(['GET', 'GET']);
    const out = join(dataDir, 'GeoLite2-City.mmdb');
    expect(await readFile(out, 'utf8')).toBe('mmdb-bytes');
    const st = await stat(out);
    expect(Math.abs(st.mtimeMs - remoteLm.getTime())).toBeLessThan(3000);
    expect(c.logs.some((l) => l.includes(FIX_RUN) && l.includes('downloading'))).toBe(
      true,
    );
    expect(c.logs.some((l) => l.includes(FIX_RUN) && l.includes('sync completed'))).toBe(
      true,
    );
  });
});
