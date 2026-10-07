const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'cloud-sync.js'), 'utf8');
const copy = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));

async function client(server, storage = new Map()) {
  const elements = {};
  const element = id => elements[id] ||= { hidden: true, textContent: '' };
  let listener;
  const emit = () => listener?.({ val: () => copy(server.data) });
  const ref = {
    once: async () => ({ val: () => copy(server.data) }),
    on: (_, callback) => { listener = callback; emit(); },
    update: async patch => {
      if (server.error) throw new Error('PERMISSION_DENIED');
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.split('/');
        let node = server.data;
        for (const part of parts.slice(0, -1)) node = node[part] ||= {};
        if (value === null) delete node[parts.at(-1)];
        else node[parts.at(-1)] = copy(value);
      }
      emit();
    },
  };
  const database = () => ({ ref: name => name === '.info/connected'
    ? { on: (_, callback) => callback({ val: () => true }) } : ref });
  database.ServerValue = { TIMESTAMP: 1 };
  const context = vm.createContext({
    console: { warn() {}, error() {} }, crypto: { randomUUID },
    document: { getElementById: element, querySelector: element },
    firebase: { apps: [], initializeApp: () => ({ database }), database },
    firebaseConfig: {}, pages: [], currentPage: 0,
    checklistSeed: { id: 'checklist' }, checklistState: { tasks: [] },
    defaultLogo: '', MAX_IMAGES_PER_SIDE: 6,
    idbGet: async key => copy(storage.get(key)),
    idbSet: async (key, value) => storage.set(key, copy(value)),
    projectSnapshot: () => ({}), renderChecklist() {}, syncFormFromPage() {},
    loadProject() {}, addEventListener() {}, setTimeout: () => 1, clearTimeout() {},
    renderPage() {}, projectHistoryBegin() {}, projectHistoryCommit() {},
    alert: message => { throw new Error(message); },
  });
  context.window = context;
  vm.runInContext(`
    function current() { return pages[currentPage]; }
    ${html.slice(html.indexOf('    function sideImages('), html.indexOf('    function sidePhotoTransforms('))}
    ${html.slice(html.indexOf('    async function applyImagesToSide('), html.indexOf('    function bindDirectUpload('))}
  `, context);
  vm.runInContext(sync, context);
  await tick();
  return { context, elements, storage, emit, flush: async () => { await element('syncRetry').onclick(); await tick(); } };
}

function server() {
  return { data: { schemaVersion: 2, order: ['item21'], checklist: { task: { id: 'task', title: 'Check', done: false } }, pages: {
    item21: { number: '21', title: 'PASSAGEM SEGURA', leftHeading: 'MODO CORRETO', rightHeading: 'MODO INCORRETO', logo: '', okLabel: 'OK', nokLabel: 'NOK', leftImages: [], rightImages: ['data:image/png;base64,original'], showCorrect: true, showIncorrect: true },
  } } };
}

test('photo upload survives a remote update during file reading, then reloads', async () => {
  const remote = server();
  const app = await client(remote);
  let finish;
  app.context.readFileAsDataURLPromise = () => new Promise(resolve => { finish = resolve; });
  const uploading = app.context.applyImagesToSide('left', [{}]);
  remote.data.pages.item21.title = 'Atualizado em outro dispositivo';
  app.emit();
  finish('data:image/png;base64,new-photo');
  await uploading;
  await app.flush();
  assert.equal(remote.data.pages.item21.leftImages[0], 'data:image/png;base64,new-photo');
  const reloaded = await client(remote);
  assert.equal(reloaded.context.pages[0].leftImages[0], 'data:image/png;base64,new-photo');
  assert.equal(reloaded.context.pages[0].title, 'Atualizado em outro dispositivo');
});

test('an upload never resurrects a page deleted during file reading', async () => {
  const remote = server();
  remote.data.pages.other = { ...copy(remote.data.pages.item21), number: '22' };
  remote.data.order.push('other');
  const app = await client(remote);
  let finish;
  app.context.readFileAsDataURLPromise = () => new Promise(resolve => { finish = resolve; });
  const uploading = app.context.applyImagesToSide('left', [{}]);
  delete remote.data.pages.item21;
  remote.data.order = ['other'];
  app.emit();
  finish('data:image/png;base64,cancelled');
  await uploading;
  await app.flush();
  assert.equal(remote.data.pages.item21, undefined);
  assert.equal(remote.data.pages.other.leftImages.length, 0);
});

test('photo framing and editable annotations survive saving and reload', async () => {
  const remote = server();
  const app = await client(remote);
  const page = app.context.pages[0];
  page.rightPhotoTransforms = [{ scale: 2, x: 10, y: -5 }];
  page.rightAnnotations = [{ version: 2, source: page.rightImages[0], width: 100, height: 80, objects: [{ id: 'mark', tool: 'text', text: 'Atenção' }] }];
  app.context.autoSaveProject();
  await app.flush();
  const reloaded = await client(remote);
  assert.equal(reloaded.context.pages[0].rightPhotoTransforms[0].scale, 2);
  assert.equal(reloaded.context.pages[0].rightAnnotations[0].objects[0].text, 'Atenção');
});

test('failed photo writes stay pending across reload and retry', async () => {
  const remote = server();
  const app = await client(remote);
  app.context.pages[0].leftImages = ['data:image/png;base64,pending'];
  app.context.autoSaveProject();
  remote.error = true;
  await app.flush();
  assert.match(app.elements.syncStatus.textContent, /Não foi possível sincronizar/);
  const reloaded = await client(remote, app.storage);
  assert.equal(reloaded.context.pages[0].leftImages[0], 'data:image/png;base64,pending');
  remote.error = false;
  await reloaded.flush();
  assert.equal(remote.data.pages.item21.leftImages[0], 'data:image/png;base64,pending');
});

test('sparse Firebase metadata retains its photo index and empty defaults', async () => {
  const remote = server();
  remote.data.pages.item21.rightImages.push('data:image/png;base64,second', 'data:image/png;base64,third');
  remote.data.pages.item21.rightAnnotations = { 2: { version: 2, source: 'third', objects: [{ id: 'mark' }] } };
  const app = await client(remote);
  const page = app.context.pages[0];
  assert.equal(page.rightAnnotations.length, 3);
  assert.equal(page.rightAnnotations[0], null);
  assert.equal(page.rightAnnotations[2].source, 'third');
  assert.equal(page.rightPhotoTransforms[0].scale, 1);
  app.emit();
  assert.equal(app.context.pages[0], page, 'open photo editors keep the active page');
  page.rightImage = page.rightImages[0];
  delete remote.data.pages.item21.rightImages;
  app.emit();
  assert.equal(app.context.sideImages(page, 'right').length, 0, 'legacy alias cannot resurrect a removed photo');
});
