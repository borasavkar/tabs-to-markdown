/*
 * Tabs to Markdown for AI — pencere (popup).
 * Kaynağı (sekmeler ya da linkler) ve ayarları toplar, işi arka plana verir,
 * ilerlemeyi gösterir. api, LOCALE, t ve localizePage shared/i18n.js'ten,
 * guessFolderName, urlWords, normalizeUrl ve folderKey shared/folder-name.js'ten gelir.
 */

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  combine: true,
  separate: true,
  ext: 'md',
  mode: 'auto',
  scrollTabs: false,
  scrollLinks: true,
  keepOpen: false,
  panel: 'tabs',
};
const MAX_LINKS = 50;
const NO_GROUP = -1;
const ALL_SITES = { origins: ['<all_urls>'] };

let settings = { ...DEFAULTS };
let memory = {}; // arka planın tuttuğu klasör hafızası: { folders, pages, groups }
let windowTabs = [];
let groups = new Map(); // groupId -> { title, tabs }
let activeTab = null;
let folderTouched = false;

// ------------------------------------------------------------------ başlangıç

init();

async function init() {
  localizePage();
  $('version').textContent = `v${api.runtime.getManifest().version}`;
  const stored = await api.storage.local.get(['settings', 'memory']);
  settings = { ...DEFAULTS, ...(stored.settings || {}) };
  memory = stored.memory || {};

  if (!(await api.permissions.contains(ALL_SITES))) {
    $('perm').hidden = false;
    $('permBtn').addEventListener('click', () => {
      api.tabs.create({ url: api.runtime.getURL('welcome/welcome.html') });
      window.close();
    });
    return;
  }

  $('form').hidden = false;
  applySettings();
  bindEvents();
  renderRecent();
  await loadTabs();

  const state = await api.runtime.sendMessage({ type: 'state' });
  if (state) renderProgress(state);
}

function applySettings() {
  $('combine').checked = settings.combine;
  $('separate').checked = settings.separate;
  $('scrollTabs').checked = settings.scrollTabs;
  $('scrollLinks').checked = settings.scrollLinks;
  $('keepOpen').checked = settings.keepOpen;
  $('mode').value = settings.mode;
  document.querySelector(`input[name="ext"][value="${settings.ext}"]`).checked = true;
  showPanel(settings.panel);
}

function readSettings() {
  settings = {
    combine: $('combine').checked,
    separate: $('separate').checked,
    ext: document.querySelector('input[name="ext"]:checked').value,
    mode: $('mode').value,
    scrollTabs: $('scrollTabs').checked,
    scrollLinks: $('scrollLinks').checked,
    keepOpen: $('keepOpen').checked,
    panel: settings.panel,
  };
  api.storage.local.set({ settings });
}

function bindEvents() {
  $('tab-tabs').addEventListener('click', () => { userFolderChoice = null; showPanel('tabs'); readSettings(); suggestFolder(); });
  $('tab-links').addEventListener('click', () => { userFolderChoice = null; showPanel('links'); readSettings(); suggestFolder(); });
  $('source').addEventListener('change', () => { userFolderChoice = null; folderTouched = false; renderTabList(); suggestFolder(); });
  $('all').addEventListener('change', () => {
    for (const cb of document.querySelectorAll('#tablist input:not(:disabled)')) cb.checked = $('all').checked;
    updateCount();
    suggestFolder();
  });
  $('tablist').addEventListener('change', () => { updateCount(); suggestFolder(); });
  $('links').addEventListener('input', () => { updateLinkCount(); suggestFolder(); });
  $('folder').addEventListener('input', () => {
    // Kutuyu boşaltırsa öneriler yeniden devreye girer.
    folderTouched = $('folder').value.trim() !== '';
    $('folderSource').textContent = '';
    if (!folderTouched) suggestFolder();
  });
  for (const id of ['combine', 'separate', 'scrollTabs', 'scrollLinks', 'keepOpen', 'mode']) {
    $(id).addEventListener('change', readSettings);
  }
  for (const r of document.querySelectorAll('input[name="ext"]')) r.addEventListener('change', readSettings);
  $('useFolder').addEventListener('change', () => { userFolderChoice = $('useFolder').checked; suggestFolder(); });
  $('go').addEventListener('click', start);
  $('stop').addEventListener('click', () => api.runtime.sendMessage({ type: 'cancel' }));
  $('show').addEventListener('click', () => api.runtime.sendMessage({ type: 'show' }));
  $('again').addEventListener('click', async () => {
    await api.runtime.sendMessage({ type: 'clear' });
    memory = (await api.storage.local.get('memory')).memory || {};
    renderRecent();
    folderTouched = false;
    suggestFolder();
    $('progress').hidden = true;
    $('form').hidden = false;
  });
  api.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'progress' && msg.job) renderProgress(msg.job);
  });
}

function showPanel(name) {
  settings.panel = name;
  $('panel-tabs').hidden = name !== 'tabs';
  $('panel-links').hidden = name !== 'links';
  $('tab-tabs').setAttribute('aria-selected', String(name === 'tabs'));
  $('tab-links').setAttribute('aria-selected', String(name === 'links'));
  if (name === 'links') $('links').focus();
}

// ------------------------------------------------------------------ sekmeler

async function loadTabs() {
  windowTabs = await api.tabs.query({ currentWindow: true });
  activeTab = windowTabs.find((tab) => tab.active) || null;

  groups = new Map();
  for (const tab of windowTabs) {
    if (tab.groupId == null || tab.groupId === NO_GROUP) continue;
    if (!groups.has(tab.groupId)) groups.set(tab.groupId, { title: '', tabs: [] });
    groups.get(tab.groupId).tabs.push(tab);
  }
  if (api.tabGroups?.get) {
    for (const [id, g] of groups) {
      try { g.title = (await api.tabGroups.get(id)).title || ''; } catch { /* başlık okunamadı */ }
    }
  }

  const select = $('source');
  select.textContent = '';
  const add = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    select.appendChild(o);
  };
  let unnamed = 1;
  for (const [id, g] of groups) add(`group:${id}`, t('sourceGroup', g.title || t('unnamedGroup', unnamed++), g.tabs.length));
  const highlighted = windowTabs.filter((tab) => tab.highlighted);
  if (highlighted.length > 1) add('selected', t('sourceSelected', highlighted.length));
  add('window', t('sourceWindow', windowTabs.length));
  add('active', t('sourceActive'));

  // Varsayılan: etkin sekmenin grubu, yoksa seçili sekmeler, yoksa yalnızca bu sekme.
  if (activeTab && activeTab.groupId != null && activeTab.groupId !== NO_GROUP) select.value = `group:${activeTab.groupId}`;
  else if (highlighted.length > 1) select.value = 'selected';
  else select.value = 'active';

  renderTabList();
  suggestFolder();
}

function tabsForSource() {
  const v = $('source').value;
  if (v.startsWith('group:')) return groups.get(Number(v.slice(6)))?.tabs || [];
  if (v === 'selected') return windowTabs.filter((tab) => tab.highlighted);
  if (v === 'window') return windowTabs;
  return activeTab ? [activeTab] : [];
}

const readable = (tab) => /^https?:/i.test(tab.url || '');

function checkedTabs() {
  const ids = new Set([...document.querySelectorAll('#tablist input:checked')].map((b) => Number(b.value)));
  return windowTabs.filter((tab) => ids.has(tab.id));
}

function selectedGroupTitle() {
  const v = $('source').value;
  return v.startsWith('group:') ? groups.get(Number(v.slice(6)))?.title || '' : '';
}

function renderTabList() {
  const list = $('tablist');
  list.textContent = '';
  for (const tab of tabsForSource()) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = String(tab.id);
    cb.checked = readable(tab);
    cb.disabled = !readable(tab);
    const text = document.createElement('span');
    const title = document.createElement('span');
    title.className = 't';
    title.dir = 'auto';
    title.textContent = tab.title || tab.url;
    title.title = tab.title || tab.url;
    const host = document.createElement('span');
    host.className = 'h';
    host.textContent = readable(tab) ? hostOf(tab.url) : t('notWebPage');
    text.append(title, host);
    label.append(cb, text);
    li.appendChild(label);
    if (!readable(tab)) li.className = 'off';
    list.appendChild(li);
  }
  $('all').checked = true;
  updateCount();
}

function updateCount() {
  const boxes = [...document.querySelectorAll('#tablist input')];
  const on = boxes.filter((b) => b.checked).length;
  $('count').textContent = t('selectedCount', on, boxes.length);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// ------------------------------------------------------------------ klasör adı

// Kural (kullanıcının istediği gibi, başka hiçbir şeye bakmadan):
// - Sekme grubu seçiliyse: klasöre kaydedilir, klasör adı grubun adıdır
//   (grubun adı yoksa sayfa başlıklarından tahmin edilir).
// - Grup yoksa: klasör açılmaz, dosya doğrudan İndirilenler'e iner. Kutucuk yalnızca
//   kullanıcı işaretlerse açılır; kendiliğinden asla açılmaz.
let userFolderChoice = null;

function isGrouped() {
  return settings.panel === 'tabs' && $('source').value.startsWith('group:');
}

function updateFolderMode() {
  const grouped = isGrouped();
  const useFolder = grouped || userFolderChoice === true;
  $('rootBox').hidden = grouped;
  $('useFolder').checked = useFolder;
  $('folderBox').hidden = !useFolder;
}

function suggestFolder() {
  updateFolderMode();
  if (folderTouched) return;
  let name = '';
  let source = '';
  if (settings.panel === 'tabs') {
    const tabs = checkedTabs();
    const groupTitle = selectedGroupTitle();
    if ((name = groupTitle)) source = 'folderFromGroup';
    else if ((name = guessFolderName(tabs.map((tab) => tab.title), LOCALE))) source = 'folderFromTitles';
  } else {
    const urls = parseLinks($('links').value);
    if ((name = guessFolderName(urls.map(urlWords), LOCALE))) source = 'folderFromLinks';
  }
  $('folder').value = name || '';
  $('folderSource').textContent = name ? t(source) : '';
}

// Son kullanılan klasörler tek tıkla seçilebilsin.
function renderRecent() {
  const box = $('recent');
  for (const b of box.querySelectorAll('button')) b.remove();
  const names = (memory.folders || []).slice(0, 5).map((f) => f.name);
  box.hidden = !names.length;
  for (const name of names) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dir = 'auto';
    b.textContent = name;
    b.addEventListener('click', () => {
      $('folder').value = name;
      folderTouched = true;
      $('folderSource').textContent = '';
    });
    box.appendChild(b);
  }
}

// ------------------------------------------------------------------ linkler

function parseLinks(text) {
  const found = [];
  const re = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  for (const m of text.matchAll(re)) {
    let u = m[0].replace(/[),.;:!?]+$/, '');
    if (/^www\./i.test(u)) u = `https://${u}`;
    try {
      const url = new URL(u);
      if (!found.includes(url.href)) found.push(url.href);
    } catch { /* geçersiz link */ }
  }
  return found;
}

function updateLinkCount() {
  const n = parseLinks($('links').value).length;
  $('linkCount').textContent = n ? t('linksFound', n) : t('linksNone');
}

// ------------------------------------------------------------------ başlat

async function start() {
  readSettings();
  showError('');
  const useFolder = isGrouped() || $('useFolder').checked;
  // Klasörsüz kayıtta ad yalnızca birleşik dosyanın adı ve başlığı için kullanılır.
  const folder = $('folder').value.trim() || (useFolder ? '' : 'Tabs to Markdown');
  if (!folder) return showError(t('errFolder'));
  if (!settings.combine && !settings.separate) return showError(t('errSaveOption'));

  const options = {
    combine: settings.combine,
    separate: settings.separate,
    ext: settings.ext,
    mode: settings.mode,
    keepOpen: settings.keepOpen,
  };
  let job;
  if (settings.panel === 'tabs') {
    const tabs = checkedTabs().map((tab) => ({ id: tab.id, url: tab.url, title: tab.title }));
    if (!tabs.length) return showError(t('errNoTabs'));
    job = { source: 'tabs', tabs, folder, useFolder, groupTitle: selectedGroupTitle(), options: { ...options, scroll: settings.scrollTabs } };
  } else {
    const urls = parseLinks($('links').value);
    if (!urls.length) return showError(t('errNoLinks'));
    if (urls.length > MAX_LINKS) return showError(t('errTooManyLinks', MAX_LINKS));
    job = { source: 'links', urls, folder, useFolder, windowId: activeTab?.windowId, options: { ...options, scroll: settings.scrollLinks } };
  }

  const res = await api.runtime.sendMessage({ type: 'start', job });
  if (!res?.ok) return showError(res?.error || t('errStart'));
}

function showError(text) {
  $('err').textContent = text;
  $('err').hidden = !text;
}

// ------------------------------------------------------------------ ilerleme

const ICONS = { bekliyor: '·', okunuyor: '…', tamam: '✓', hata: '✗', engel: '!', iptal: '–' };

function renderProgress(job) {
  $('form').hidden = true;
  $('progress').hidden = false;

  const finished = job.items.filter((it) => !['bekliyor', 'okunuyor'].includes(it.status)).length;
  const ok = job.items.filter((it) => it.status === 'tamam').length;
  const bad = job.items.filter((it) => ['hata', 'engel'].includes(it.status)).length;
  $('barFill').style.width = `${job.total ? Math.round((finished / job.total) * 100) : 0}%`;

  let summary;
  if (job.running) {
    summary = t('progressRunning', finished, job.total);
  } else if (job.error) {
    summary = job.error;
  } else if (ok) {
    summary = job.useFolder === false
      ? t('progressDoneRoot', ok, t('downloadsFolder'), job.files.length)
      : t('progressDone', ok, t('downloadsFolder'), job.folder, job.files.length);
    if (bad) summary += ` ${t('progressFailed', bad)}`;
  } else {
    summary = t('progressNone');
  }
  $('summary').textContent = summary;

  const list = $('results');
  list.textContent = '';
  for (const it of job.items) {
    const li = document.createElement('li');
    li.className = it.status;
    const icon = document.createElement('span');
    icon.className = 'i';
    icon.textContent = ICONS[it.status] || '·';
    const title = document.createElement('span');
    title.className = 't';
    title.dir = 'auto';
    title.textContent = it.label;
    title.title = it.url || it.label;
    li.append(icon, title);
    if (it.note) {
      const note = document.createElement('span');
      note.className = 'n';
      note.textContent = it.note;
      li.appendChild(note);
    }
    list.appendChild(li);
  }

  $('stop').hidden = !job.running;
  $('again').hidden = job.running;
  $('show').hidden = job.running || job.showId == null;
}
