const WORKER_ORIGIN = 'https://__LH_WORKER_URL__'

function isProxiedPath(pathname) {
  return pathname.startsWith('/api/') || pathname.startsWith('/admin/')
}

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url)

    if (isProxiedPath(incomingUrl.pathname)) {
      const upstreamUrl = new URL(
        `${incomingUrl.pathname}${incomingUrl.search}`,
        WORKER_ORIGIN,
      )
      return fetch(new Request(upstreamUrl, request))
    }

    return env.ASSETS.fetch(request)
  },
}
