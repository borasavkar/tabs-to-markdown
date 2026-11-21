// Tabs to Markdown for AI — paketleme betiği.
//
//   node build.mjs
//
// 1) i18n/messages.mjs dosyasından extension/_locales/<dil>/messages.json üretir ve denetler
//    (eksik anahtar, $1/$2 sayısı, mağaza açıklama uzunluğu).
// 2) extension/ klasörü ortak koddur ve Firefox'un manifest'ini taşır.
//    Chrome için chrome/manifest.json ile PNG simgeler bunun üstüne konur.
// Çıktılar:
//   dist/chrome/                          Chrome'a "paketlenmemiş" yüklenecek klasör
//   dist/md_creator-chrome-<sürüm>.zip    Chrome Web Mağazası paketi
//   dist/md_creator-firefox-<sürüm>.zip   Mozilla'ya (AMO) yüklenecek paket

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'extension');
const dist = join(root, 'dist');
const chromeDir = join(dist, 'chrome');

// ------------------------------------------------------------------ dil dosyaları

const { default: MESSAGES, DEFAULT_LOCALE } = await import(pathToFileURL(join(root, 'i18n', 'messages.mjs')));
const base = MESSAGES[DEFAULT_LOCALE];
const placeholders = (s) => (s.match(/\$\d/g) || []).sort().join(',');
const problems = [];

rmSync(join(src, '_locales'), { recursive: true, force: true });
for (const [locale, messages] of Object.entries(MESSAGES)) {
  for (const key of Object.keys(base)) {
    if (key === 'extName') continue; // ad her dilde aynı kalır
    if (!(key in messages)) problems.push(`${locale}: eksik anahtar ${key}`);
  }
  for (const [key, text] of Object.entries(messages)) {
    if (!(key in base)) problems.push(`${locale}: İngilizce'de olmayan anahtar ${key}`);
    else if (placeholders(text) !== placeholders(base[key])) problems.push(`${locale}.${key}: $ yer tutucuları İngilizce ile uyuşmuyor`);
  }
  const desc = messages.extDescription ?? base.extDescription;
  if ([...desc].length > 132) problems.push(`${locale}: açıklama ${[...desc].length} karakter (Chrome sınırı 132)`);

  const json = Object.fromEntries(Object.entries(messages).map(([k, v]) => [k, { message: v }]));
  mkdirSync(join(src, '_locales', locale), { recursive: true });
  writeFileSync(join(src, '_locales', locale, 'messages.json'), `${JSON.stringify(json, null, 2)}\n`);
}
if (problems.length) {
  console.error(`Dil dosyalarında sorun var:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`hazır: ${Object.keys(MESSAGES).length} dil (${Object.keys(MESSAGES).join(', ')})`);

// ------------------------------------------------------------------ paketler

const version = (file) => JSON.parse(readFileSync(file, 'utf8')).version;
const firefoxVersion = version(join(src, 'manifest.json'));
const chromeVersion = version(join(root, 'chrome', 'manifest.json'));

// Windows'ta zip üretebilen tar, System32 içindekidir (Git'in tar'ı zip yapamaz).
const winTar = 'C:\\Windows\\System32\\tar.exe';
const tar = process.platform === 'win32' && existsSync(winTar) ? winTar : 'tar';

function zip(dir, out) {
  rmSync(out, { force: true });
  execFileSync(tar, ['-a', '-cf', out, '-C', dir, ...readdirSync(dir)]);
  console.log(`hazır: ${out}`);
}

mkdirSync(dist, { recursive: true });

// Chrome klasörü: ortak kod + Chrome manifest'i + PNG simgeler.
rmSync(chromeDir, { recursive: true, force: true });
cpSync(src, chromeDir, { recursive: true, filter: (p) => !p.endsWith('manifest.json') });
cpSync(join(root, 'chrome', 'manifest.json'), join(chromeDir, 'manifest.json'));
cpSync(join(root, 'chrome', 'icons'), join(chromeDir, 'icons'), { recursive: true });
console.log(`hazır: ${chromeDir}`);

zip(chromeDir, join(dist, `md_creator-chrome-${chromeVersion}.zip`));
zip(src, join(dist, `md_creator-firefox-${firefoxVersion}.zip`));
