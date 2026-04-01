/** Resolved from environment variables for HTTP server, paths, and MaxMind sync. */
export const config = {
  baseUrl: process.env.BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
  development: process.env.NODE_ENV !== 'production',
  production: process.env.NODE_ENV === 'production',
  environment: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 3000,
  dataDir: process.env.DATA_DIR || './data',
  /** Required. Send as `X-API-Key` or `Authorization: Bearer …` on every API request. */
  apiKey: process.env.IP_LOOKUP_API_KEY ?? 'your-secret-key-here',
  maxmind: {
    AccountID: process.env.MAXMIND_ACCOUNT_ID,
    LicenseKey: process.env.MAXMIND_LICENSE_KEY,
    EditionIDs: process.env.MAXMIND_EDITION_IDS || 'GeoLite2-City',
    downloadUrl: process.env.MAXMIND_DOWNLOAD_URL,
    mmdbFilename: process.env.MAXMIND_MMDB_FILENAME || 'GeoLite2-City.mmdb',
  },
};
