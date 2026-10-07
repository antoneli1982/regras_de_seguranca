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
  const OUTBOX = 'cloud-pending:' + ROOT;
  let localWrites = Promise.resolve(), localSaving = 0, localError = false;
  function persistPending() {
    const snapshot = copy(pending);
    localSaving++;
    localWrites = localWrites.catch(() => {}).then(() => idbSet(OUTBOX, snapshot));
    localWrites.then(() => { localError = false; }, error => {
      localError = true;
      console.error('Falha ao preservar alterações:', error);
      message('Falha ao salvar neste dispositivo. Mantenha a aba aberta e tente novamente.');
      retry.hidden = false;
    }).finally(() => { localSaving--; });
    return localWrites;
  }
  const photoFields = ['leftAnnotations', 'rightAnnotations', 'leftPhotoTransforms', 'rightPhotoTransforms'];
  const fields = ['number', 'title', 'leftHeading', 'rightHeading', 'okLabel', 'nokLabel', 'logo', 'leftImages', 'rightImages', 'showCorrect', 'showIncorrect', ...photoFields];

  function photoMetadata(page, key) {
    const side = key.startsWith('left') ? 'left' : 'right';
    // Firebase omits empty arrays and may return sparse arrays as keyed objects.
    return Array.from({ length: page[side + 'Images'].length }, (_, index) =>
      copy(page[key]?.[index] ?? (key.endsWith('PhotoTransforms') ? { scale: 1, x: 0, y: 0 } : null)));
  }

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
        else if (photoFields.includes(key)) item[key] = photoMetadata(page, key);
        else if (key === 'showIncorrect' || key === 'showCorrect') item[key] = page[key] !== false;
        else item[key] = String(page[key] ?? '');
      });
      model.pages[page.id] = item;
      model.order.push(page.id);
    });
    model.checklist = {};
    checklistState.tasks.forEach(task => { model.checklist[task.id] = copy(task); });
    return model;
  }
  function normalize(model) {
    if (!model || model.schemaVersion !== 2 || !model.pages) throw new Error('Formato de projeto inválido.');
    const result = copy(model);
    result.checklist ||= {};
    result.order = (result.order || []).filter(id => result.pages[id]);
    Object.keys(result.pages).forEach(id => {
      if (!result.order.includes(id)) result.order.push(id);
      result.pages[id].leftImages ||= [];
      result.pages[id].rightImages ||= [];
      photoFields.forEach(key => { result.pages[id][key] = photoMetadata(result.pages[id], key); });
    });
    if (!result.order.length) throw new Error('Projeto sem páginas.');
    return result;
  }
  function merge(model, patch) {
    const result = copy(model);
    result.checklist ||= {};
    Object.entries(patch).forEach(([path, value]) => {
      if (path === 'order') return;
      if (path.startsWith('checklist/')) {
        const [, taskId, taskField] = path.split('/');
        if (taskField) { if (result.checklist[taskId]) result.checklist[taskId][taskField] = copy(value); }
        else if (value === null) delete result.checklist[taskId];
        else result.checklist[taskId] = copy(value);
        return;
      }
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
    const existing = new Map(pages.map(page => [page.id, page]));
    pages = model.order.map(id => {
      // Uploads and open photo editors hold this object while awaiting image reads.
      // Replacing it on every Firebase event silently cancels those operations.
      const page = existing.get(id) || {};
      Object.keys(page).forEach(key => { delete page[key]; });
      return Object.assign(page, copy(model.pages[id]), { id });
    });
    const samePage = pages.findIndex(p => p.id === selected);
    currentPage = samePage >= 0 ? samePage : Math.min(currentPage, pages.length - 1);
    checklistState = {id: checklistSeed.id, tasks: Object.values(copy(model.checklist || {}))};
    renderChecklist();
    document.getElementById('checkSaveStatus').textContent = 'Checklist compartilhado entre navegadores.';
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
    Object.keys(view.checklist).forEach(id => { if (!next.checklist[id]) pending['checklist/' + id] = null; });
    Object.entries(next.checklist).forEach(([id, task]) => {
      if (!view.checklist[id]) pending['checklist/' + id] = task;
      else ['title', 'note', 'done'].forEach(key => {
        if (!equal(task[key] ?? null, view.checklist[id][key] ?? null)) {
          if (pending['checklist/' + id]) pending['checklist/' + id][key] = task[key] ?? '';
          else pending['checklist/' + id + '/' + key] = task[key] ?? '';
        }
      });
    });
    if (!equal(view.order, next.order)) pending.order = next.order;
    view = next;
    if (Object.keys(pending).length) {
      persistPending();
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
      await persistPending();
      const remote = (await ref.once('value')).val();
      if (!remote) throw new Error('Projeto remoto indisponível.');
      // Send only changed fields; photos no longer resend the entire project
      // through a transaction with a much smaller payload limit.
      const changes = copy(patch);
      Object.keys(changes).forEach(path => {
        const [, id, field] = path.split('/');
        if (path.startsWith('pages/') && field && !remote.pages?.[id]) delete changes[path];
      });
      if (changes.order) changes.order = merge(remote, changes).order;
      changes.updatedAt = firebase.database.ServerValue.TIMESTAMP;
      await ref.update(changes);
      Object.keys(patch).forEach(key => { if (equal(patch[key], pending[key])) delete pending[key]; });
      await persistPending();
      latest = normalize((await ref.once('value')).val());
      display(merge(latest, pending));
      message(Object.keys(pending).length ? 'Salvando alterações…' : 'Sincronizado entre dispositivos');
      retry.hidden = true;
    } catch (error) {
      console.error('Falha na sincronização:', error);
      message(localError ? 'Não foi possível salvar. Mantenha esta aba aberta.' : 'Não foi possível sincronizar. Alterações preservadas neste dispositivo; tente novamente.');
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
      pending = (await idbGet(OUTBOX)) || {};
      const snapshot = await ref.once('value');
      let remote = snapshot.val();
      if (remote === null) {
        // Seed only after a confirmed empty read, and never overwrite a racing client.
        await restoreAutoSavedProject();
        await compressLegacyPhotos();
        const seed = pack();
        const result = await ref.transaction(existing => existing === null ? seed : undefined, undefined, false);
        remote = result.snapshot.val();
      }
      if (!remote.checklist) {
        // Migrate this browser only once; an existing shared checklist always wins.
        const seedTasks = pack().checklist;
        await ref.child('checklist').transaction(existing => existing === null ? seedTasks : undefined, undefined, false);
        remote = (await ref.once('value')).val();
      }
      latest = normalize(remote);
      display(merge(latest, pending));
      ready = true;
      app.inert = false;
      db.ref('.info/connected').on('value', snap => {
        connected = snap.val() === true;
        message(Object.keys(pending).length ? 'Alterações preservadas — aguardando sincronização' : connected ? 'Sincronizado entre dispositivos' : 'Sem conexão — alterações aguardando envio');
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
    if (saving || localSaving || localError || Object.keys(pending).length) { event.preventDefault(); event.returnValue = ''; }
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
