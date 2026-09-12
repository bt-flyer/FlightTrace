/* global self, caches, fetch, URL, Headers, Response */
const CACHE_NAME = 'flighttrace-shell-__BUILD_ID__'
const PAGE_CACHE_MAX_AGE_MS = 10 * 60 * 1000
const CACHED_AT_HEADER = 'X-FlightTrace-Cached-At'

function withCacheTimestamp(response) {
  const headers = new Headers(response.headers)
  headers.set(CACHED_AT_HEADER, Date.now().toString())
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

function pageCacheIsFresh(response) {
  const cachedAt = Number(response?.headers.get(CACHED_AT_HEADER))
  const age = Date.now() - cachedAt
  return Boolean(response && Number.isFinite(cachedAt) && age >= 0 && age < PAGE_CACHE_MAX_AGE_MS)
}

async function cachePage(response) {
  const cache = await caches.open(CACHE_NAME)
  await Promise.all([
    cache.put('./index.html', withCacheTimestamp(response.clone())),
    cache.put('./', withCacheTimestamp(response.clone()))
  ])
}

async function pageResponse(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match('./index.html')
  if (pageCacheIsFresh(cached)) return cached
  try {
    const response = await fetch(request, { cache: 'no-store' })
    if (response.ok) {
      await cachePage(response)
      return response
    }
    if (cached) return cached
    return response
  } catch (error) {
    if (cached) return cached
    throw error
  }
}

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME)
  const indexResponse = await fetch('./index.html', { cache: 'no-store' })
  const html = await indexResponse.clone().text()
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((path) => !path.startsWith('data:') && new URL(path, self.location.href).origin === self.location.origin)
  await cachePage(indexResponse)
  await cache.addAll([...new Set(['./app-icon.svg', './manifest.webmanifest', ...assets])])

  // The CSV worker is embedded in the application script and cached with it.
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('flighttrace-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url)
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin) return

  if (event.request.mode === 'navigate') {
    event.respondWith(pageResponse(event.request))
    return
  }

  event.respondWith(caches.match(event.request, { ignoreSearch: true, ignoreVary: true }).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone()
      void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy))
    }
    return response
  })))
})
