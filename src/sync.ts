import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import type { IpLookupService } from './ipLookupService.js';
import type { Logger } from './logger.js';

export const SYNC_INTERVAL_MS = 60 * 60 * 1000;
/** Local file is treated as stale after one week without a usable remote timestamp. */
export const LOCAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MAXMIND_DB_BASE = 'https://download.maxmind.com/geoip/databases';

export type MaxMindSyncSource = {
  downloadUrl?: string;
  editionIds?: string;
};

export type MaxMindSyncInput = MaxMindSyncSource & {
  accountId?: string;
  licenseKey?: string;
  dataDir: string;
  mmdbFilename: string;
};

export function buildDownloadPermalink(source: MaxMindSyncSource): string | undefined {
  const explicit = source.downloadUrl?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  const editions = source.editionIds
    ?.trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  const edition = editions?.[0];
  if (!edition) return undefined;

  return `${MAXMIND_DB_BASE}/${encodeURIComponent(edition)}/download?suffix=tar.gz`;
}

export function basicAuthHeader(accountId: string, licenseKey: string): string {
  const token = Buffer.from(`${accountId}:${licenseKey}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

export function shouldDownload(
  localMtimeMs: number | undefined,
  remoteTime: Date | null,
  now: number,
): boolean {
  if (localMtimeMs === undefined) return true;

  const localAge = now - localMtimeMs;
  const staleByAge = localAge >= LOCAL_MAX_AGE_MS;

  if (!remoteTime) {
    return staleByAge;
  }

  if (remoteTime.getTime() <= localMtimeMs + 2000) {
    return false;
  }

  return true;
}

async function findMmdbFile(dir: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const found = await findMmdbFile(p);
      if (found) return found;
    } else if (e.name.endsWith('.mmdb')) {
      return p;
    }
  }
  return undefined;
}

async function defaultExtractTarGz(archivePath: string, destDir: string): Promise<void> {
  const proc = Bun.spawn(['tar', '-xzf', archivePath, '-C', destDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar failed (${code}): ${err || 'unknown'}`);
  }
}

export type MaxMindSyncDeps = {
  now: () => number;
  fetch: typeof fetch;
  mkdir: typeof mkdir;
  stat: typeof stat;
  copyFile: typeof copyFile;
  rename: typeof rename;
  rm: typeof rm;
  utimes: typeof utimes;
  extractTarGz: (archivePath: string, destDir: string) => Promise<void>;
  writeResponseToPath: (filePath: string, response: Response) => Promise<void>;
};

export function createDefaultMaxMindSyncDeps(): MaxMindSyncDeps {
  return {
    now: () => Date.now(),
    fetch: globalThis.fetch.bind(globalThis) as typeof fetch,
    mkdir,
    stat,
    copyFile,
    rename,
    rm,
    utimes,
    extractTarGz: defaultExtractTarGz,
    writeResponseToPath: async (filePath, response) => {
      await Bun.write(filePath, response);
    },
  };
}

let cachedDefaultDeps: MaxMindSyncDeps | undefined;

export function getDefaultMaxMindSyncDeps(): MaxMindSyncDeps {
  cachedDefaultDeps ??= createDefaultMaxMindSyncDeps();
  return cachedDefaultDeps;
}

function maxMindSyncInputFromAppConfig(): MaxMindSyncInput {
  return {
    accountId: config.maxmind.AccountID?.trim(),
    licenseKey: config.maxmind.LicenseKey?.trim(),
    dataDir: config.dataDir,
    mmdbFilename: config.maxmind.mmdbFilename,
    downloadUrl: config.maxmind.downloadUrl,
    editionIds: config.maxmind.EditionIDs,
  };
}

const MAXMIND_REDIRECT_CAP = 10;

const MAXMIND_ERROR_BODY_CHARS = 900;

function maxMindRequestUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    const base = `${u.origin}${u.pathname}`;
    return u.search ? `${base}?…` : base;
  } catch {
    return url;
  }
}

async function readTruncatedErrorBody(res: Response): Promise<string> {
  try {
    const t = await res.text();
    const oneLine = t.replace(/\s+/g, ' ').trim();
    if (!oneLine) return '';
    if (oneLine.length <= MAXMIND_ERROR_BODY_CHARS) return oneLine;
    return `${oneLine.slice(0, MAXMIND_ERROR_BODY_CHARS)}…`;
  } catch {
    return '';
  }
}

async function maxMindHttpError(
  label: string,
  res: Response,
  requestUrl: string,
): Promise<Error> {
  const body = await readTruncatedErrorBody(res);
  const statusLine = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  const lines = [`${label}: ${statusLine}`, maxMindRequestUrlForLog(requestUrl)];
  if (body) lines.push(body);
  return new Error(lines.join('\n'));
}

/** Send Basic Auth only on the first URL; omit Authorization after redirect (e.g. presigned URL). */
async function fetchMaxMindWithRedirects(
  fetchFn: typeof fetch,
  url: string,
  method: 'HEAD' | 'GET',
  auth: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  let currentUrl = url;
  let useAuth = true;

  for (let hop = 0; hop < MAXMIND_REDIRECT_CAP; hop++) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (useAuth) {
      headers.Authorization = auth;
    }

    const res = await fetchFn(currentUrl, {
      method,
      headers,
      redirect: 'manual',
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel?.();
      if (!loc) {
        throw new Error(
          `MaxMind redirect ${res.status} missing Location (${maxMindRequestUrlForLog(currentUrl)})`,
        );
      }
      currentUrl = new URL(loc, currentUrl).href;
      useAuth = false;
      continue;
    }

    return res;
  }

  throw new Error(
    `MaxMind: too many redirects (${MAXMIND_REDIRECT_CAP}), last ${maxMindRequestUrlForLog(currentUrl)}`,
  );
}

async function fetchLastModified(
  fetchFn: typeof fetch,
  url: string,
  auth: string,
): Promise<Date | null> {
  const res = await fetchMaxMindWithRedirects(fetchFn, url, 'GET', auth, {
    Range: 'bytes=0-0',
  });

  if (!res.ok) {
    throw await maxMindHttpError('MaxMind metadata probe failed', res, url);
  }

  const contentLen = parseInt(res.headers.get('content-length') ?? '0', 10);
  const hasRange = res.headers.get('content-range') != null;
  if (res.status === 200 && !hasRange && contentLen > 65_536) {
    await res.body?.cancel?.();
    throw new Error(
      `MaxMind metadata probe: range ignored, large response (${maxMindRequestUrlForLog(url)})`,
    );
  }

  await res.body?.cancel?.();

  const lm = res.headers.get('last-modified');
  return lm ? new Date(lm) : null;
}

async function downloadAndInstallMmdb(
  deps: MaxMindSyncDeps,
  downloadUrl: string,
  auth: string,
  dataDir: string,
  targetPath: string,
  remoteTime: Date | null,
): Promise<void> {
  const res = await fetchMaxMindWithRedirects(deps.fetch, downloadUrl, 'GET', auth);
  if (!res.ok) {
    throw await maxMindHttpError('MaxMind download failed', res, downloadUrl);
  }

  const tmpRoot = join(dataDir, `.sync-tmp-${deps.now()}`);
  const archivePath = join(tmpRoot, 'db.tar.gz');
  await deps.mkdir(tmpRoot, { recursive: true });

  try {
    await deps.writeResponseToPath(archivePath, res);
    await deps.extractTarGz(archivePath, tmpRoot);
    const mmdb = await findMmdbFile(tmpRoot);
    if (!mmdb) {
      throw new Error('No .mmdb file found in downloaded archive');
    }

    const partial = `${targetPath}.partial`;
    await deps.copyFile(mmdb, partial);
    await deps.rename(partial, targetPath);

    const t = remoteTime ?? new Date(deps.now());
    await deps.utimes(targetPath, t, t);
  } finally {
    await deps.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export type RunMaxMindSyncOptions = {
  logger: Logger;
  runId?: string;
  /** After a successful download, reload the local MMDB in the lookup service. */
  lookupService?: Pick<IpLookupService, 'reloadDatabase'>;
};

export async function runMaxMindSync(
  deps: MaxMindSyncDeps,
  input: MaxMindSyncInput,
  options: RunMaxMindSyncOptions,
): Promise<void> {
  const runId = options.runId ?? randomUUID();
  const log = options.logger.child({ component: 'maxmind-sync', runId });

  const accountId = input.accountId?.trim();
  const licenseKey = input.licenseKey?.trim();
  if (!accountId || !licenseKey) {
    log.warn('skip: missing credentials');
    return;
  }

  const downloadUrl = buildDownloadPermalink(input);
  if (!downloadUrl) {
    log.warn('skip: no download URL or edition IDs');
    return;
  }

  await deps.mkdir(input.dataDir, { recursive: true });

  const targetPath = join(input.dataDir, input.mmdbFilename);
  const auth = basicAuthHeader(accountId, licenseKey);

  let localMtime: number | undefined;
  try {
    const st = await deps.stat(targetPath);
    localMtime = st.mtimeMs;
  } catch {
    localMtime = undefined;
  }

  const now = deps.now();
  if (localMtime !== undefined && now - localMtime < LOCAL_MAX_AGE_MS) {
    log.info('skip sync: local database younger than 7 days (no remote check)');
    return;
  }

  let remoteTime: Date | null = null;
  try {
    remoteTime = await fetchLastModified(deps.fetch, downloadUrl, auth);
  } catch (e) {
    if (localMtime === undefined) throw e;
    log.error('metadata probe failed', { err: e });
    return;
  }

  if (!shouldDownload(localMtime, remoteTime, now)) {
    log.info('up to date');
    return;
  }

  log.info('downloading');
  await downloadAndInstallMmdb(
    deps,
    downloadUrl,
    auth,
    input.dataDir,
    targetPath,
    remoteTime,
  );
  log.info('sync completed', { targetPath });

  if (options.lookupService) {
    try {
      await options.lookupService.reloadDatabase();
      log.info('lookup database reloaded', { targetPath });
    } catch (e) {
      log.error('lookup database reload failed', { err: e, targetPath });
    }
  }
}

export async function runMaxMindSyncOnce(
  logger: Logger,
  options?: Pick<RunMaxMindSyncOptions, 'runId' | 'lookupService'>,
): Promise<void> {
  const runId = options?.runId ?? randomUUID();
  return runMaxMindSync(getDefaultMaxMindSyncDeps(), maxMindSyncInputFromAppConfig(), {
    logger,
    runId,
    lookupService: options?.lookupService,
  });
}

export function startMaxMindSyncHourly(
  logger: Logger,
  options?: Pick<RunMaxMindSyncOptions, 'lookupService'>,
): ReturnType<typeof setInterval> {
  const kick = () => {
    const runId = randomUUID();
    void runMaxMindSyncOnce(logger, {
      runId,
      lookupService: options?.lookupService,
    }).catch((e) => {
      logger.error('maxmind sync run failed', {
        component: 'maxmind-sync',
        runId,
        err: e,
      });
    });
  };
  kick();
  return setInterval(kick, SYNC_INTERVAL_MS);
}
