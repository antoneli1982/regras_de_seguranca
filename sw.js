/* SESE Studio — service worker
   Abre a ferramenta instantaneamente (e sem internet) a partir da cópia guardada,
   atualiza essa cópia em segundo plano e guarda o vídeo de abertura para as TVs. */
const CACHE = 'sese-studio-v2';
const MEDIA = 'sese-media-v1'; // vídeo fica guardado entre versões (16 MB)

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
      .then(keys => Promise.all(keys.filter(key => key.startsWith('sese-studio-') && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

const isVideo = url => /\.(mp4|webm|mov|m4v)$/i.test(url.pathname);
const videoKey = url => { const u = new URL(url); u.search = ''; u.hash = ''; return u.href; };

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.cachePage && new URL(data.cachePage).origin === self.location.origin) {
    event.waitUntil(caches.open(CACHE).then(cache => cache.add(new Request(data.cachePage, { cache: 'reload' }))).catch(() => {}));
  }
  if (data.cacheVideo && new URL(data.cacheVideo).origin === self.location.origin) {
    // Baixa o vídeo inteiro uma única vez; depois ele toca do aparelho.
    event.waitUntil((async () => {
      const cache = await caches.open(MEDIA);
      const key = videoKey(data.cacheVideo);
      if (await cache.match(key)) return;
      const response = await fetch(key, { cache: 'reload' });
      if (response.ok && response.status === 200) await cache.put(key, response);
    })().catch(() => {}));
  }
});

// Atende pedidos parciais (Range) do player a partir do vídeo guardado.
async function videoResponse(request) {
  const cached = await (await caches.open(MEDIA)).match(videoKey(request.url));
  if (!cached) return fetch(request);
  const range = request.headers.get('range');
  if (!range) return cached;
  const blob = await cached.blob();
  const total = blob.size;
  const match = /bytes=(\d*)-(\d*)/.exec(range) || [];
  let start = match[1] ? parseInt(match[1], 10) : NaN;
  let end = match[2] ? parseInt(match[2], 10) : NaN;
  if (isNaN(start)) { start = Math.max(0, total - (isNaN(end) ? total : end)); end = total - 1; }
  if (isNaN(end) || end >= total) end = total - 1;
  if (start >= total || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'video/mp4',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Firebase e outros domínios seguem direto para a rede.
  if (url.origin !== self.location.origin) return;
  if (isVideo(url)) { event.respondWith(videoResponse(request)); return; }

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
