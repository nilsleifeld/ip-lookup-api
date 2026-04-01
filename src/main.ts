import { serve } from 'bun';
import { join } from 'node:path';
import { config } from './config.js';
import { handleIpLookupFromClient, handleIpLookupFromQuery } from './handlers.js';
import { IpLookupService } from './ipLookupService.js';
import { Logger } from './logger.js';
import { startMaxMindSyncHourly } from './sync.js';

const logger = new Logger({ service: 'ip-lookup-api' });

if (!config.maxmind.AccountID) {
  throw new Error('MAXMIND_ACCOUNT_ID is not set');
}

logger.info('MaxMind account configured', {
  accountId: config.maxmind.AccountID,
});

if (!config.maxmind.LicenseKey) {
  throw new Error('MAXMIND_LICENSE_KEY is not set');
}

if (!config.apiKey?.trim()) {
  throw new Error('IP_LOOKUP_API_KEY is not set');
}

const mmdbPath = join(config.dataDir, config.maxmind.mmdbFilename);
const lookupService = new IpLookupService(mmdbPath);

void lookupService.reloadDatabase().catch(() => {
  logger.warn('initial MMDB open skipped or failed (sync may install it soon)', {
    path: mmdbPath,
  });
});

startMaxMindSyncHourly(logger, { lookupService });

const lookupRouteDeps = {
  lookupService,
  logger,
  apiKey: config.apiKey.trim(),
};

const httpServer = serve({
  routes: {
    '/api/v1/ip-lookup': {
      GET(req) {
        return handleIpLookupFromQuery(req, lookupRouteDeps);
      },
    },
    '/api/v1/ip-lookup/me': {
      GET(req, srv) {
        return handleIpLookupFromClient(req, srv, lookupRouteDeps);
      },
    },
  },
});

logger.info('Server listening', { url: String(httpServer.url) });
