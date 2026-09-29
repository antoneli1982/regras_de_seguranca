/* Shared project on Spark: no Storage, billing, authentication or expiry. */
(() => {
  const ROOT = 'regras_de_seguranca/projeto';
  const status = document.getElementById('syncStatus');
  const retry = document.getElementById('syncRetry');
  const app = document.querySelector('.app');
  const copy = value => JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let ref, ready = false, connected = false, saving = false;
  let view = null, latest = null, pending = {}, timer;
  const fields = ['number', 'title', 'leftHeading', 'rightHeading', 'okLabel', 'nokLabel', 'logo', 'leftImages', 'rightImages', 'showIncorrect'];

  function message(text) { status.textContent = text; }
  async function compressLegacyPhotos() {
    const converted = new Map();
    async function convert(source) {
      if (!source?.startsWith('data:image/')) return source;
      if (!converted.has(source)) {
        const blob = await (await fetch(source)).blob();
        converted.set(source, await readFileAsDataURLPromise(blob));
      }
      return converted.get(source);
    }
    for (const page of pages) {
      for (const side of ['left', 'right']) {
        page[side + 'Images'] = await Promise.all(sideImages(page, side).map(convert));
        page[side + 'Image'] = page[side + 'Images'][0] || '';
      }
      if (page.logo && page.logo !== defaultLogo) page.logo = await convert(page.logo);
    }
  }
  function pack() {
    const model = { schemaVersion: 2, pages: {}, order: [] };
    const used = new Set();
    pages.forEach(page => {
      if (!page.id || used.has(page.id)) page.id = crypto.randomUUID();
      used.add(page.id);
      const item = {};
      fields.forEach(key => {
        if (key.endsWith('Images')) item[key] = [...sideImages(page, key.startsWith('left') ? 'left' : 'right')];
        else if (key === 'showIncorrect') item[key] = page[key] !== false;
        else item[key] = String(page[key] ?? '');
      });
      model.pages[page.id] = item;
      model.order.push(page.id);
    });
    return model;
  }
  function normalize(model) {
    if (!model || model.schemaVersion !== 2 || !model.pages) throw new Error('Formato de projeto inválido.');
    const result = copy(model);
    result.order = (result.order || []).filter(id => result.pages[id]);
    Object.keys(result.pages).forEach(id => {
      if (!result.order.includes(id)) result.order.push(id);
      result.pages[id].leftImages ||= [];
      result.pages[id].rightImages ||= [];
    });
    if (!result.order.length) throw new Error('Projeto sem páginas.');
    return result;
  }
  function merge(model, patch) {
    const result = copy(model);
    Object.entries(patch).forEach(([path, value]) => {
      if (path === 'order') return;
      const [, id, field] = path.split('/');
      if (field) {
        // An edit from an old tab must not resurrect a deleted page.
        if (result.pages[id]) result.pages[id][field] = copy(value);
      } else if (value === null) delete result.pages[id];
      else result.pages[id] = copy(value);
    });
    if (patch.order) {
      const desired = patch.order.filter(id => result.pages[id]);
      result.order = [...desired, ...(result.order || []).filter(id => result.pages[id] && !desired.includes(id))];
    }
    return normalize(result);
  }
  function display(model) {
    const selected = pages[currentPage]?.id;
    pages = model.order.map(id => ({ ...copy(model.pages[id]), id }));
    const samePage = pages.findIndex(p => p.id === selected);
    currentPage = samePage >= 0 ? samePage : Math.min(currentPage, pages.length - 1);
    syncFormFromPage();
    view = pack();
    idbSet('cloud-cache', projectSnapshot()).catch(console.warn);
  }
  function capture() {
    if (!ready) return;
    const next = pack();
    Object.keys(view.pages).forEach(id => {
      if (!next.pages[id]) pending['pages/' + id] = null;
    });
    Object.entries(next.pages).forEach(([id, page]) => {
      if (!view.pages[id]) pending['pages/' + id] = page;
      else fields.forEach(key => {
        if (!equal(page[key], view.pages[id][key])) {
          if (pending['pages/' + id]) pending['pages/' + id][key] = page[key];
          else pending['pages/' + id + '/' + key] = page[key];
        }
      });
    });
    if (!equal(view.order, next.order)) pending.order = next.order;
    view = next;
    if (Object.keys(pending).length) {
      message(connected ? 'Salvando alterações…' : 'Sem conexão — alterações aguardando envio');
      clearTimeout(timer);
      timer = setTimeout(flush, 500);
    }
  }
  async function flush() {
    clearTimeout(timer);
    if (!ready || saving || !Object.keys(pending).length) return;
    if (!connected) { message('Sem conexão — mantenha esta aba aberta para sincronizar'); return; }
    saving = true;
    const patch = copy(pending);
    message('Salvando alterações…');
    try {
      const result = await ref.transaction(remote => {
        if (!remote) return; // Never replace a missing server project with stale local data.
        const merged = merge(remote, patch);
        if (JSON.stringify(merged).length > 12000000) throw new Error('Projeto grande demais. Remova algumas fotos e tente novamente.');
        merged.updatedAt = firebase.database.ServerValue.TIMESTAMP;
        return merged;
      }, undefined, false);
      if (!result.committed) throw new Error('Projeto remoto indisponível. Recarregue a página.');
      Object.keys(patch).forEach(key => { if (equal(patch[key], pending[key])) delete pending[key]; });
      latest = normalize(result.snapshot.val());
      display(merge(latest, pending));
      message(Object.keys(pending).length ? 'Salvando alterações…' : 'Sincronizado entre dispositivos');
      retry.hidden = true;
    } catch (error) {
      console.error('Falha na sincronização:', error);
      message('Não foi possível salvar. Suas alterações continuam nesta aba.');
      retry.hidden = false;
    } finally {
      saving = false;
      if (Object.keys(pending).length && retry.hidden) timer = setTimeout(flush, 500);
    }
  }
  async function start() {
    app.inert = true;
    retry.hidden = true;
    message('Carregando projeto compartilhado…');
    try {
      if (!window.firebase) throw new Error('Não foi possível carregar o serviço de sincronização.');
      const instance = firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig);
      const db = instance.database();
      ref = db.ref(ROOT);
      const snapshot = await ref.once('value');
      let remote = snapshot.val();
      if (remote === null) {
        // Seed only after a confirmed empty read, and never overwrite a racing client.
        await restoreAutoSavedProject();
        await compressLegacyPhotos();
        const seed = pack();
        if (JSON.stringify(seed).length > 12000000) throw new Error('Backup grande demais para carregar.');
        const result = await ref.transaction(existing => existing === null ? seed : undefined, undefined, false);
        remote = result.snapshot.val();
      }
      latest = normalize(remote);
      display(latest);
      ready = true;
      app.inert = false;
      db.ref('.info/connected').on('value', snap => {
        connected = snap.val() === true;
        message(connected ? 'Sincronizado entre dispositivos' : 'Sem conexão — alterações aguardando envio');
        if (connected && Object.keys(pending).length) flush();
      });
      ref.on('value', snap => {
        try {
          latest = normalize(snap.val());
          display(merge(latest, pending));
        } catch (error) {
          console.error(error);
          message('Projeto remoto indisponível. Recarregue para tentar novamente.');
        }
      }, error => {
        console.error(error);
        message('Não foi possível receber atualizações. Recarregue para tentar novamente.');
      });
    } catch (error) {
      console.error('Falha ao abrir projeto:', error);
      message('Não foi possível abrir o projeto compartilhado. Verifique a conexão.');
      retry.hidden = false;
    }
  }
  window.scheduleCloudSave = capture;
  window.autoSaveProject = capture;
  retry.onclick = () => ready ? flush() : start();
  window.addEventListener('beforeunload', event => {
    if (saving || Object.keys(pending).length) { event.preventDefault(); event.returnValue = ''; }
  });
  // Existing backup stays local; restoring it is an explicit shared-project edit.
  const restoreBackup = loadProject;
  document.getElementById('loadProjectBtn').onclick = async () => {
    if (!confirm('Carregar o backup deste dispositivo e substituir o projeto compartilhado?')) return;
    await restoreBackup();
    await compressLegacyPhotos();
    capture();
  };
  start();
})();
