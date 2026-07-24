# Admin Authentication (cookie session + CSRF)

The admin dashboard authenticates against the Worker API with an **HttpOnly
session cookie** instead of an API key stored in `localStorage`. This removes
the XSS-exposed credential (OSS security issue #102) while keeping SDK/MCP
Bearer-token access unchanged.

## How it works

1. **Same-origin proxy** — production Pages deployments route `/api/*` and
   `/admin/*` through `apps/web/public/_worker.js` to the Worker API. The
   browser therefore sees the request and cookies as first-party to the admin
   origin, including on Safari/iOS.
2. **Login** — `POST /api/auth/login { apiKey }`. The Worker validates the key
   (staff table, `API_KEY`, or `LEGACY_API_KEY`) and sets two cookies:
   - `lh_admin_session` — the credential. **HttpOnly**, `Secure`, `Path=/`,
     `Max-Age=604800`. JavaScript can never read it.
   - `lh_csrf` — a random CSRF token. Readable, `Secure`. Also returned in the
     response body.
3. **Authenticated requests** — the browser sends `lh_admin_session`
   automatically (`credentials: 'include'`). For state-changing requests
   (`POST/PUT/PATCH/DELETE`) the SPA also sends the CSRF token in the
   `X-CSRF-Token` header; the Worker rejects the request (`403`) unless that
   header matches the `lh_csrf` cookie (double-submit).
4. **Session check** — `GET /api/auth/session` returns the staff identity and
   the current CSRF token (minting one if missing), letting the SPA recover the
   token after a reload without re-login.
5. **Logout** — `POST /api/auth/logout` expires both cookies.

### Why the CSRF token is also returned in the body

The CSRF token is returned in the response body and cached client-side so the
same client code also works in direct-to-Worker development and legacy
deployments. The Worker still validates the header against its own received
cookie; the API key itself remains only in the HttpOnly session cookie.

### Bearer tokens are unaffected

SDK and MCP callers continue to send `Authorization: Bearer <key>`. They are not
cookie-driven, so CSRF enforcement does not apply to them, and CORS does not
affect non-browser (no `Origin`) callers.

## Topology & configuration

Cookies only reach the API if `SameSite` matches the topology. The Worker reads
three environment variables (see
`apps/worker/src/middleware/admin-auth-config.ts`):

| Variable | Purpose |
|----------|---------|
| `ADMIN_ORIGIN` | Comma-separated allowlist of admin origins for credentialed CORS. No trailing slash. |
| `ADMIN_ALLOW_CROSS_SITE` | `true` → issue `SameSite=None; Secure` cookies (required when admin and API are cross-site). |
| `ADMIN_COOKIE_SAMESITE` | Optional explicit override: `Strict` \| `Lax` \| `None`. |

The admin build also reads `NEXT_PUBLIC_ADMIN_API_PROXY`. Official Pages
deployments set it to `true`; local development can leave it unset and call
`NEXT_PUBLIC_API_URL` directly.

### Two supported deployments

**(a) Cross-site Pages ↔ Workers (default).** Set
`ADMIN_ORIGIN=https://<admin>.pages.dev` and `ADMIN_ALLOW_CROSS_SITE=true`.
`create-line-harness` does this automatically after deploying the admin. The
Pages same-origin proxy forwards requests to the Worker, so the browser no
longer treats the session cookie as third-party. Cookies remain HttpOnly and
`SameSite=None; Secure`; CSRF protects mutations; CORS is locked to the
allowlist.

Cloudflare Pages also prints per-deployment preview URLs such as
`https://<hash>.<admin>.pages.dev`. Those preview origins are treated as the
same admin Pages project, so clicking Wrangler's fresh deployment URL does not
cause a login-time CORS failure.

Older admin deployments without `_worker.js` still call the Worker cross-site
and can fail on Safari/iOS because those browsers block third-party cookies.
Redeploy the current admin bundle to install the proxy.

**(b) Same-site custom domains (recommended).** Serve the admin and API under
one registrable domain — e.g. `admin.example.com` (Pages custom domain) and
`api.example.com` (Worker route). Set `ADMIN_ORIGIN=https://admin.example.com`
and leave `ADMIN_ALLOW_CROSS_SITE` unset; cookies use `SameSite=Lax` and no
third-party-cookie restrictions apply.

### Topology guard

If the admin is cross-site to the API but `SameSite` is not `None` (e.g. the old
`SameSite=Strict`, or a custom domain misconfiguration), `POST /api/auth/login`
**refuses with a 500 and an actionable error** rather than silently issuing a
cookie the browser will drop. This converts the "login breaks after deploy"
failure mode into a clear configuration error.
