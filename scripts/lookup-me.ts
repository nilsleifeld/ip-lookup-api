const IPIFY_URL = 'https://api.ipify.org?format=json';

const baseUrl =
  process.env.BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

const ipLookupUrl = `${baseUrl.replace(/\/$/, '')}/api/v1/ip-lookup`;
const apiKey = process.env.IP_LOOKUP_API_KEY?.trim() ?? 'your-secret-key-here';

type IpifyResponse = {
  ip: string;
};

async function main() {
  const ipifyRes = await fetch(IPIFY_URL);
  if (!ipifyRes.ok) {
    throw new Error(`ipify: ${ipifyRes.status} ${ipifyRes.statusText}`);
  }
  const ipifyJson = (await ipifyRes.json()) as IpifyResponse;
  console.log(`ipify: ${ipifyJson.ip}`);

  const ipLookupRes = await fetch(`${ipLookupUrl}?ip=${ipifyJson.ip}`, {
    headers: { 'X-API-Key': apiKey },
  });
  if (!ipLookupRes.ok) {
    throw new Error(`ip-lookup: ${ipLookupRes.status} ${ipLookupRes.statusText}`);
  }
  const ipLookupJson: unknown = await ipLookupRes.json();
  console.log(JSON.stringify(ipLookupJson, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
