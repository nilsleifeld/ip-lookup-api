# HTTP API reference

Base path: `/api/v1`.

All responses use **`Content-Type: application/json`** unless noted.

---

## Authentication

Every endpoint requires the **API key** configured on the server as the environment variable **`IP_LOOKUP_API_KEY`**. If it is missing at startup, the process exits with an error.

Send the key using **either** of the following (not both required):

| Header                   | Example                            |
| ------------------------ | ---------------------------------- |
| `X-API-Key`              | `X-API-Key: <your-key>`            |
| `Authorization` (Bearer) | `Authorization: Bearer <your-key>` |

Requests without a key, or with a wrong key, receive **`401 Unauthorized`**:

```json
{
  "error": "missing api key"
}
```

or

```json
{
  "error": "invalid api key"
}
```

---

## `GET /api/v1/ip-lookup`

Resolves geolocation for an explicit IP using the loaded MaxMind MMDB (GeoIP2 City–style record).

### Request

| Part   | Description                                           |
| ------ | ----------------------------------------------------- |
| Method | `GET`                                                 |
| Query  | **`ip`** (required) — IPv4 or IPv6 address to look up |

No request body.

**Example**

```http
GET /api/v1/ip-lookup?ip=145.255.49.45
X-API-Key: <your-key>
```

### Response bodies

#### `200 OK` — success

The body is a JSON object produced from the MaxMind **`City`** reader model: nested records such as `city`, `continent`, `country`, `location`, `postal`, `subdivisions`, `traits`, and optional `registeredCountry`, `representedCountry`, `maxmind`. Which fields appear depends on the database edition (e.g. GeoLite2-City vs paid City).

Field semantics match MaxMind’s GeoIP2 City schema. See the [GeoIP2 City database documentation](https://dev.maxmind.com/geoip/docs/databases/city-and-country) and [response Body section](https://dev.maxmind.com/geoip/docs/web-services/responses#city) for record shapes.

**Example** (illustrative; real payloads vary by IP and DB edition):

```json
{
  "city": {
    "geonameId": 2921044,
    "names": { "en": "Frankfurt am Main" }
  },
  "continent": {
    "code": "EU",
    "geonameId": 6255148,
    "names": { "en": "Europe" }
  },
  "country": {
    "geonameId": 2921044,
    "isoCode": "DE",
    "isInEuropeanUnion": true,
    "names": { "en": "Germany" }
  },
  "location": {
    "accuracyRadius": 20,
    "latitude": 50.1153,
    "longitude": 8.6823,
    "timeZone": "Europe/Berlin"
  },
  "traits": {
    "isAnonymous": false,
    "isAnonymousProxy": false,
    "isAnonymousVpn": false,
    "isHostingProvider": false,
    "isPublicProxy": false,
    "isResidentialProxy": false,
    "isTorExitNode": false,
    "ipAddress": "145.255.49.45"
  }
}
```

#### `401 Unauthorized`

Missing or invalid API key — see [Authentication](#authentication).

#### `400 Bad Request`

Missing `ip`:

```json
{
  "error": "query parameter ip is required"
}
```

Invalid IP (MaxMind `ValueError`):

```json
{
  "error": "invalid ip",
  "ip": "not-an-ip",
  "message": "<library message>"
}
```

#### `404 Not Found`

IP not present in the database:

```json
{
  "error": "address not found",
  "ip": "192.0.2.1"
}
```

#### `503 Service Unavailable`

MMDB not loaded yet (e.g. first start before sync completes):

```json
{
  "error": "database not ready"
}
```

#### `500 Internal Server Error`

Unexpected lookup failure:

```json
{
  "error": "lookup failed"
}
```

---

## `GET /api/v1/ip-lookup/me`

Same lookup as `/api/v1/ip-lookup`, but the IP is derived from the incoming request (see below).

### Request

| Part               | Description                                 |
| ------------------ | ------------------------------------------- |
| Method             | `GET`                                       |
| Query              | None                                        |
| Headers (optional) | Used to infer client IP when behind proxies |

**Client IP resolution order**

1. `X-Forwarded-For` — first entry in the comma-separated list (after normalizing IPv6 brackets and stripping an IPv4 `:port` suffix).
2. Else, in order: `CF-Connecting-IP`, `True-Client-IP`, `X-Real-IP` (same normalization).
3. Else the connection peer address from the server (`requestIP`).

**Example**

```http
GET /api/v1/ip-lookup/me
X-API-Key: <your-key>
```

**Example** (simulate client behind a proxy):

```http
GET /api/v1/ip-lookup/me
X-API-Key: <your-key>
X-Forwarded-For: 203.0.113.42
```

No request body.

### Response bodies

#### `200 OK`

Same shape as [`GET /api/v1/ip-lookup`](#200-ok--success) success response for the resolved client IP.

#### `401 Unauthorized`

Same as [`GET /api/v1/ip-lookup`](#401-unauthorized).

#### `400 Bad Request`

Client IP could not be determined:

```json
{
  "error": "could not determine client ip"
}
```

Invalid resolved IP, unknown address, DB not ready, or server error: same JSON bodies and status codes as in [`GET /api/v1/ip-lookup`](#response-bodies) (`400` with `invalid ip`, `404`, `503`, `500`).

---

## Summary table

| Endpoint                   | Condition             | Status                | `error` (if applicable)               |
| -------------------------- | --------------------- | --------------------- | ------------------------------------- |
| both                       | no / wrong API key    | 401                   | `missing api key` / `invalid api key` |
| `GET /api/v1/ip-lookup`    | no `ip` param         | 400                   | `query parameter ip is required`      |
| `GET /api/v1/ip-lookup`    | invalid IP            | 400                   | `invalid ip`                          |
| `GET /api/v1/ip-lookup`    | IP not in DB          | 404                   | `address not found`                   |
| `GET /api/v1/ip-lookup`    | no MMDB               | 503                   | `database not ready`                  |
| `GET /api/v1/ip-lookup`    | other failure         | 500                   | `lookup failed`                       |
| `GET /api/v1/ip-lookup/me` | IP unknown            | 400                   | `could not determine client ip`       |
| `GET /api/v1/ip-lookup/me` | (then same as lookup) | 400 / 404 / 503 / 500 | same as above                         |

Success responses for both routes return a **GeoIP2 City–shaped JSON object** with no `error` field.
