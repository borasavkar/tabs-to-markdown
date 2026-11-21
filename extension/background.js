/*
 * Tabs to Markdown for AI — arka plan.
 *
 * Pencereden (popup) gelen işi yürütür: sekmeleri ya da linkleri sırayla okur,
 * Markdown dosyalarını İndirilenler/<klasör> içine kaydeder. Pencere kapansa da
 * iş burada sürer; pencere yeniden açılınca durumu buradan okur.
 *
 * Aynı dosya Firefox'ta (MV2 arka plan sayfası) ve Chrome'da (MV3 service
 * worker) çalışır; tarayıcı farkları aşağıdaki yardımcılarda ele alınır.
 */

// Chrome'da (service worker) ortak yardımcılar burada yüklenir; Firefox'ta manifest yükler.
if (typeof importScripts === 'function' && typeof normalizeUrl === 'undefined') importScripts('shared/folder-name.js');

const api = globalThis.browser ?? globalThis.chrome;
const LOCALE = api.i18n.getUILanguage();
const t = (key, ...subs) => api.i18n.getMessage(key, subs.map(String)) || key;
const ALL_SITES = { origins: ['<all_urls>'] };

// İlk kurulumda tanıtım sayfası açılır; sitelere erişim izni orada istenir.
api.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') api.tabs.create({ url: api.runtime.getURL('welcome/welcome.html') });
});

const INJECT_FILES = ['lib/Readability.js', 'lib/turndown.js', 'content/extract.js'];
const LOAD_TIMEOUT = 45000; // bir sayfanın yüklenmesi için en fazla bekleme (ms)
const PAGE_TIMEOUT = 90000; // bir sayfanın okunması için en fazla bekleme (ms)
const SETTLE_DELAY = 1500; // yeni açılan sayfada sonradan yüklenen kısımlar için bekleme (ms)
const KEEPALIVE_MS = 20000; // Chrome arka planı boşta kalınca uyutur; iş sürerken uyanık tutar

let job = null;

// Cevaplar sendResponse ile verilir; bu yöntem iki tarayıcıda da çalışır.
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'start':
      if (job?.running) {
        sendResponse({ ok: false, error: t('errBusy') });
      } else {
        runJob(msg.job);
        sendResponse({ ok: true });
      }
      break;
    case 'state':
      sendResponse(job);
      break;
    case 'cancel':
      if (job?.running) job.cancelled = true;
      sendResponse(true);
      break;
    case 'clear':
      if (!job?.running) job = null;
      sendResponse(true);
      break;
    case 'show':
      showFile(job?.showId);
      sendResponse(true);
      break;
    default:
      break;
  }
  return false;
});

function broadcast() {
  Promise.resolve(api.runtime.sendMessage({ type: 'progress', job })).catch(() => { /* pencere kapalı */ });
}

function setItem(i, patch) {
  Object.assign(job.items[i], patch);
  broadcast();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runJob(spec) {
  const items = spec.source === 'tabs'
    ? spec.tabs.map((t) => ({ tabId: t.id, url: t.url, label: t.title || t.url }))
    : spec.urls.map((u) => ({ url: u, label: u }));

  job = {
    running: true,
    folder: spec.folder,
    useFolder: spec.useFolder !== false,
    total: items.length,
    items: items.map((it) => ({ label: it.label, url: it.url, status: 'bekliyor', note: '' })),
    files: [],
    showId: null,
    error: '',
  };
  broadcast();

  const keepAlive = setInterval(() => { api.runtime.getPlatformInfo?.(); }, KEEPALIVE_MS);
  const results = [];
  const failed = [];
  const keptTabs = [];

  try {
    if (!(await api.permissions.contains(ALL_SITES))) {
      job.error = t('errPermissionMissing');
      for (const it of job.items) it.status = 'iptal';
      return;
    }
    for (let i = 0; i < items.length; i++) {
      if (job.cancelled) {
        for (let j = i; j < items.length; j++) job.items[j].status = 'iptal';
        break;
      }
      setItem(i, { status: 'okunuyor' });
      let res;
      try {
        if (spec.source === 'tabs') {
          res = await readTab(items[i].tabId, spec.options);
        } else {
          const r = await readUrl(items[i].url, spec.options, spec.windowId);
          res = r.result;
          if (r.tabId != null && spec.options.keepOpen) keptTabs.push(r.tabId);
        }
      } catch (e) {
        res = { ok: false, error: errorText(e) };
      }

      if (res?.ok) {
        results.push(res);
        setItem(i, { status: 'tamam', label: res.title || items[i].label, note: sizeText(res.chars) });
      } else {
        failed.push({ url: items[i].url, label: items[i].label, error: res?.error || t('errUnknown') });
        setItem(i, { status: res?.blocked ? 'engel' : 'hata', note: res?.error || t('errUnknown') });
      }
    }

    if (keptTabs.length) await groupTabs(keptTabs, spec.folder);

    if (results.length) {
      try {
        await saveFiles(results, failed, spec);
        // Klasörsüz kayıtlar hafızaya yazılmaz; hafıza yalnızca araştırma klasörleri içindir.
        if (spec.useFolder !== false) await remember(spec, results).catch(() => { /* hafıza yazılamadı; dosyalar yine kaydedildi */ });
      } catch (e) {
        job.error = t('errSave', errorText(e));
      }
    }
  } finally {
    clearInterval(keepAlive);
    job.running = false;
    broadcast();
  }
}

// ------------------------------------------------------------------ okuma

async function readTab(tabId, opts) {
  const tab = await api.tabs.get(tabId);
  if (!/^https?:/i.test(tab.url || '')) {
    return { ok: false, error: t('errNotWeb') };
  }
  if (tab.discarded) {
    // Tarayıcı uzun süre bakılmayan sekmeleri bellekten boşaltır; önce yeniden yüklüyoruz.
    await api.tabs.reload(tabId);
    await waitForLoad(tabId);
    await sleep(SETTLE_DELAY);
  } else if (tab.status !== 'complete') {
    await waitForLoad(tabId);
  }
  return extractFrom(tabId, opts);
}

async function readUrl(url, opts, windowId) {
  const tab = await api.tabs.create({ url, active: false, windowId });
  try {
    await waitForLoad(tab.id);
    await sleep(SETTLE_DELAY);
    return { result: await extractFrom(tab.id, opts), tabId: tab.id };
  } finally {
    if (!opts.keepOpen) Promise.resolve(api.tabs.remove(tab.id)).catch(() => {});
  }
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      api.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info, tab) => {
      if (id === tabId && info.status === 'complete' && tab.url !== 'about:blank') finish();
    };
    const timer = setTimeout(finish, LOAD_TIMEOUT);
    api.tabs.onUpdated.addListener(listener);
    api.tabs.get(tabId).then((t) => {
      if (t.status === 'complete' && !t.discarded && t.url !== 'about:blank') finish();
    }).catch(finish);
  });
}

// Okuyucu betikleri sekmeye ekler. Chrome (MV3) "scripting" API'sini,
// Firefox (MV2) tabs.executeScript'i kullanır.
async function inject(tabId) {
  if (api.scripting?.executeScript) {
    await api.scripting.executeScript({ target: { tabId }, files: INJECT_FILES });
  } else {
    for (const file of INJECT_FILES) await api.tabs.executeScript(tabId, { file: `/${file}`, runAt: 'document_idle' });
  }
}

async function extractFrom(tabId, opts) {
  try {
    await inject(tabId);
  } catch (e) {
    const msg = errorText(e);
    if (/error page/i.test(msg)) return { ok: false, error: t('errErrorPage') };
    return { ok: false, error: t('errNoAccess', msg) };
  }
  const timeout = sleep(PAGE_TIMEOUT).then(() => ({ ok: false, error: t('errTimeout') }));
  const run = api.tabs.sendMessage(tabId, { type: 'mdc-run', opts });
  return Promise.race([run, timeout]);
}

async function groupTabs(tabIds, title) {
  if (!api.tabs.group) return;
  try {
    const groupId = await api.tabs.group({ tabIds });
    if (api.tabGroups?.update) await api.tabGroups.update(groupId, { title });
  } catch { /* sekme grubu kurulamadı; sekmeler yine açık kalır */ }
}

// ------------------------------------------------------------------ kayıt

async function saveFiles(results, failed, spec) {
  const { options } = spec;
  const ext = options.ext === 'txt' ? 'txt' : 'md';
  const name = safeName(spec.folder) || 'Tabs to Markdown';
  const files = [];
  const single = results.length === 1;

  // Klasörsüz kayıt (sekme grubu yokken varsayılan): dosyalar doğrudan İndirilenler'e iner.
  // Klasör yığını olmasın diye tek sayfada sayfa adıyla tek dosya, çok sayfada yalnızca birleşik dosya yazılır.
  if (spec.useFolder === false) {
    if (single) {
      files.push({ name: `${safeName(results[0].title, 90) || name}.${ext}`, text: results[0].markdown, main: true });
    } else {
      files.push({ name: `${name} - ${safeName(t('allFiles'))} (${stamp()}).${ext}`, text: combined(results, failed, spec.folder), main: true });
    }
    return writeFiles(files, ext);
  }

  const dir = name;
  // Tek sayfa varsa "TÜMÜ" dosyası aynı içeriğin kopyası olurdu; yalnızca sayfa dosyası yazılır.
  if (!single && (options.combine || !options.separate)) {
    files.push({ name: `${dir}/00 - ${dir} - ${safeName(t('allFiles'))} (${stamp()}).${ext}`, text: combined(results, failed, spec.folder), main: true });
  }
  if (single || options.separate) {
    results.forEach((r, i) => {
      files.push({ name: `${dir}/${String(i + 1).padStart(2, '0')} - ${safeName(r.site, 25)} - ${safeName(r.title, 70)}.${ext}`, text: r.markdown });
    });
  }
  return writeFiles(files, ext);
}

async function writeFiles(files, ext) {
  const guard = guardFilenames();
  try {
    for (const f of files) {
      const id = await download(f.name, f.text, ext);
      if (job.showId == null || f.main) job.showId = id;
      job.files.push(f.name);
    }
  } finally {
    guard.release();
  }
}

// Chrome'da indirme yöneticisi gibi başka eklentiler dosya adını belirleme adımına
// girip bizim verdiğimiz adı ve klasörü ezebiliyor (dosyalar "indir.md" olarak iner).
// Kayıt süresince kendi indirmelerimiz için adı bu adımda yeniden bildiririz;
// Chrome'da en son kurulan eklentinin önerisi geçerli olur. Firefox'ta bu adım yoktur.
const wantedNames = new Map(); // indirme adresi -> istenen dosya adı

// Chrome bu olaya eklenti başına tek dinleyici kabul ediyor ("Too many listeners").
// Bu yüzden tek bir dinleyici tutulur; art arda kayıtlarda yeniden kullanılır.
let filenameListener = null;
let releaseTimer = null;

function guardFilenames() {
  const event = api.downloads.onDeterminingFilename;
  if (!event) return { release() {} };
  clearTimeout(releaseTimer);
  if (!filenameListener) {
    filenameListener = (item, suggest) => {
      const name = item.byExtensionId === api.runtime.id && (wantedNames.get(item.url) || wantedNames.get(item.finalUrl));
      if (name) suggest({ filename: name, conflictAction: 'uniquify' });
      else suggest();
    };
    event.addListener(filenameListener);
  }
  return {
    release() {
      // Son indirmenin ad belirleme adımı bitsin diye kısa bir süre sonra bırak.
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => {
        event.removeListener(filenameListener);
        filenameListener = null;
        wantedNames.clear();
      }, 5000);
    },
  };
}

// Firefox'un arka plan sayfası blob adresi üretebilir. Chrome'un service
// worker'ında bu yok; orada metin data: adresi olarak verilir.
async function download(filename, text, ext) {
  const type = ext === 'md' ? 'text/markdown' : 'text/plain';
  if (typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
    wantedNames.set(url, filename);
    try {
      return await api.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }
  const url = `data:${type};charset=utf-8,${encodeURIComponent(text)}`;
  wantedNames.set(url, filename);
  return api.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
}

function showFile(id) {
  try {
    if (id != null) api.downloads.show(id);
    else api.downloads.showDefaultFolder();
  } catch {
    api.downloads.showDefaultFolder();
  }
}

function combined(results, failed, folder) {
  const when = new Date().toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' });
  let md = `# ${folder}\n\n`;
  md += `${t('combinedIntro', results.length, t('extName'))}\n\n`;
  md += `- ${t('savedAt')}: ${when}\n- ${t('pageCount')}: ${results.length}\n\n`;
  md += `## ${t('toc')}\n\n`;
  md += results.map((r, i) => `${i + 1}. ${r.title} (${r.site})`).join('\n') + '\n\n';
  if (failed.length) {
    md += `## ${t('failedPages')}\n\n`;
    md += failed.map((f) => `- ${f.url || f.label}: ${f.error}`).join('\n') + '\n\n';
  }
  results.forEach((r, i) => {
    // Sayfa başlıkları bir alt seviyeye iner, ilk başlığa sıra numarası eklenir.
    const body = r.markdown.replace(/^(#{1,5}) /gm, '#$1 ').replace(/^## /, `## ${t('pageN', i + 1)}: `);
    md += `---\n\n${body.trim()}\n\n`;
  });
  return md.trim() + '\n';
}

// ------------------------------------------------------------------ klasör hafızası

// Aynı araştırmaya sonra yeni sekme eklendiğinde klasör adını yeniden yazmamak için:
// son kullanılan klasörler, hangi sayfanın hangi klasöre kaydedildiği ve sekme
// grubunun adıyla seçilen klasör saklanır. Yalnızca tarayıcının eklenti deposunda durur.
const MEMORY_LIMITS = { folders: 12, pages: 1000, groups: 100 };

async function remember(spec, results) {
  const { memory = {} } = await api.storage.local.get('memory');
  const now = Date.now();
  const folder = spec.folder;

  memory.folders = [{ name: folder, at: now }, ...(memory.folders || []).filter((f) => f.name !== folder)]
    .slice(0, MEMORY_LIMITS.folders);

  const urls = new Set(spec.source === 'tabs' ? spec.tabs.map((tab) => tab.url) : spec.urls);
  for (const r of results) urls.add(r.url);
  memory.pages = memory.pages || {};
  for (const u of urls) memory.pages[normalizeUrl(u)] = { folder, at: now };
  memory.pages = newest(memory.pages, MEMORY_LIMITS.pages);

  if (spec.groupTitle) {
    memory.groups = memory.groups || {};
    memory.groups[folderKey(spec.groupTitle)] = { folder, at: now };
    memory.groups = newest(memory.groups, MEMORY_LIMITS.groups);
  }
  await api.storage.local.set({ memory });
}

function newest(map, limit) {
  return Object.fromEntries(Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, limit));
}

// ------------------------------------------------------------------ yardımcılar

function safeName(s, max = 80) {
  let n = String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.length > max) n = n.slice(0, max).trim();
  n = n.replace(/^[.\s]+|[.\s]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n = `_${n}`;
  return n;
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

function sizeText(chars) {
  if (!chars) return '';
  const n = new Intl.NumberFormat(LOCALE, { notation: 'compact', compactDisplay: 'long', maximumFractionDigits: 0 }).format(chars);
  return t('sizeChars', n);
}

function errorText(e) {
  return String(e?.message || e || '').replace(/^Error:\s*/, '');
}
