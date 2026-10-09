/* SESE Studio — service worker
   Abre a ferramenta instantaneamente (e sem internet) a partir da cópia guardada,
   e atualiza essa cópia em segundo plano quando há sinal. */
const CACHE = 'sese-studio-v1';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled(['./', './index.html'].map(url => cache.add(new Request(url, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// A página avisa seu próprio endereço para garantir que ele fique guardado.
self.addEventListener('message', event => {
  const url = event.data && event.data.cachePage;
  if (!url || new URL(url).origin !== self.location.origin) return;
  event.waitUntil(caches.open(CACHE).then(cache => cache.add(new Request(url, { cache: 'reload' }))).catch(() => {}));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Firebase, vídeo (requisições parciais) e outros domínios seguem direto para a rede.
  if (url.origin !== self.location.origin) return;
  if (request.headers.has('range') || /\.(mp4|webm|mov|m4v)$/i.test(url.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const isPage = request.mode === 'navigate';
    const cached = await cache.match(request, { ignoreSearch: isPage });
    const network = fetch(request).then(response => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    });
    if (cached) {
      // Cópia guardada na hora; versão nova baixada em segundo plano para a próxima abertura.
      event.waitUntil(network.catch(() => {}));
      return cached;
    }
    try {
      return await network;
    } catch (error) {
      if (isPage) {
        const fallback = await cache.match('./', { ignoreSearch: true }) || await cache.match('./index.html');
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});
