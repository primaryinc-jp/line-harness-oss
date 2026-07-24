const WORKER_API_URL = process.env.NEXT_PUBLIC_API_URL

if (!WORKER_API_URL) {
  throw new Error(
    'NEXT_PUBLIC_API_URL is not set. Build cannot proceed without a valid Worker URL.',
  )
}

/**
 * Browser-facing admin API origin.
 *
 * Production Pages deployments enable the same-origin proxy so Safari and
 * other browsers never have to accept a third-party session cookie. The
 * Worker URL remains available separately through NEXT_PUBLIC_API_URL for
 * public webhook, LIFF, and tracked-link URLs shown in the dashboard.
 */
export const ADMIN_API_BASE_URL =
  process.env.NEXT_PUBLIC_ADMIN_API_PROXY === 'true'
    ? ''
    : WORKER_API_URL.replace(/\/+$/, '')

export function adminApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${ADMIN_API_BASE_URL}${normalizedPath}`
}
