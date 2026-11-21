/*
 * Klasör adı yardımcıları (pencere ve arka plan ortak kullanır).
 *
 * guessFolderName: sekme başlıklarında ya da link adreslerinde ortak geçen
 * anlamlı ifadeyi bulur ("Bluetooth Kulaklık", "Telefon Tutucu" gibi).
 * Fiyat, "en ucuz" gibi kelimeler, site adları ve ürün kodları yok sayılır.
 * normalizeUrl: aynı sayfanın farklı adreslerini (takip parametreleri vb.) birleştirir.
 */

const FOLDER_STOP_WORDS = new Set([
  // Türkçe alışveriş başlıklarında sık geçen ama ürünü anlatmayan kelimeler
  've', 'ile', 'icin', 'bir', 'bu', 'en', 'ucuz', 'ucuzu', 'fiyat', 'fiyati', 'fiyatlari', 'fiyatlar',
  'satin', 'al', 'alin', 'ozellikleri', 'yorumlari', 'modelleri', 'cesitleri', 'indirimli', 'kampanyali',
  'kampanya', 'sepette', 'urun', 'urunler', 'urunleri', 'orijinal', 'yeni', 'adet', 'tl', 'kargo', 'bedava',
  'ucretsiz', 'arama', 'sonuclari', 'firsati', 'firsatlari', 'cok', 'satanlar', 'magaza', 'magazasi',
  // English
  'the', 'and', 'for', 'with', 'of', 'to', 'in', 'on', 'by', 'from', 'best', 'buy', 'price', 'prices',
  'cheap', 'cheapest', 'deal', 'deals', 'sale', 'review', 'reviews', 'online', 'shop', 'store', 'new',
  'official', 'free', 'shipping', 'search', 'results', 'sellers', 'top', 'compare',
  // Site ve adres parçaları
  'www', 'com', 'tr', 'net', 'org', 'html', 'htm', 'php', 'trendyol', 'hepsiburada', 'amazon', 'n11',
  'akakce', 'cimri', 'ebay', 'aliexpress', 'walmart', 'google', 'dp', 'ref', 'sr', 'urun', 'product',
  'products', 'item', 'items', 'p', 'pm', 'gp', 'sspa',
]);

// Karşılaştırma anahtarı: büyük/küçük harf, Türkçe harfler ve aksanlar yok sayılır
// (adres içindeki "kulaklik" ile başlıktaki "Kulaklık" aynı kelime sayılır).
function folderKey(word) {
  return word.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
}

function folderTokens(text) {
  return String(text || '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => ({ text: w, key: folderKey(w) }))
    .filter(({ key }) =>
      key.length > 1
      && !FOLDER_STOP_WORDS.has(key)
      && !/^\d{4,}$/.test(key) // uzun sayılar (ürün numarası)
      && !(/\d/.test(key) && /[a-z]/.test(key) && key.length >= 6)); // ürün kodları (B0CRTYZG5C, HBCV000072PXK3)
}

// Bir adresteki anlamlı kelimeler: yol parçaları ve arama terimi parametreleri.
function urlWords(url) {
  try {
    const u = new URL(url);
    const parts = decodeURIComponent(u.pathname).split('/');
    for (const k of ['q', 'k', 'query', 'search', 'keyword', 'text', 'term']) {
      if (u.searchParams.get(k)) parts.push(u.searchParams.get(k));
    }
    return parts.join(' ');
  } catch {
    return '';
  }
}

// Tamamı küçük harf olan kelimelerin (adreslerden gelenler) ilk harfi büyütülür;
// "R50i", "iPhone" gibi karışık yazımlara dokunulmaz.
function capitalizeWords(text, locale) {
  return text.replace(/\S+/g, (w) => (w === w.toLocaleLowerCase(locale) && /^\p{L}/u.test(w)
    ? w[0].toLocaleUpperCase(locale) + w.slice(1) : w));
}

function guessFolderName(texts, locale) {
  const docs = texts.map(folderTokens).filter((d) => d.length);
  if (!docs.length) return '';
  if (docs.length === 1) {
    // Tek sayfa: başlığın site adı ve açıklamalardan önceki kısmı (ürün adı), en çok 6 kelime.
    const head = String(texts.find((s) => folderTokens(s).length)).split(/\s[|–—-]\s|[,:(]/)[0];
    const words = folderTokens(head).length ? folderTokens(head) : docs[0];
    return capitalizeWords(words.slice(0, 6).map((w) => w.text).join(' '), locale);
  }

  // Her ifade (1-3 kelime) kaç ayrı başlıkta geçiyor?
  const grams = new Map();
  for (const tokens of docs) {
    const seen = new Set();
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const gram = tokens.slice(i, i + n);
        if (gram.every((w) => /^\d+$/.test(w.key))) continue;
        const key = gram.map((w) => w.key).join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = grams.get(key) || { df: 0, n, forms: new Map() };
        entry.df++;
        const form = gram.map((w) => w.text).join(' ');
        entry.forms.set(form, (entry.forms.get(form) || 0) + 1);
        grams.set(key, entry);
      }
    }
  }

  // Puan: kaç başlıkta geçtiği × uzunluk payı. Böylece 4 başlıktan 3'ünde geçen
  // "Bluetooth Kulaklık", 4'ünde de geçen tek başına "Kulaklık"tan önde olur.
  const minDf = Math.max(2, Math.ceil(docs.length * 0.3));
  let best = null;
  for (const e of grams.values()) {
    if (e.df < minDf) continue;
    e.score = e.df * (1 + 0.5 * (e.n - 1));
    if (!best || e.score > best.score || (e.score === best.score && (e.n > best.n || (e.n === best.n && e.df > best.df)))) best = e;
  }
  if (!best) return capitalizeWords(docs[0].slice(0, 4).map((w) => w.text).join(' '), locale);
  const form = [...best.forms.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return capitalizeWords(form, locale);
}

// Aynı sayfayı tanımak için: sorgu ve # kısmı atılır; Amazon'da ürün kodu esas alınır.
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const asin = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (/(^|\.)amazon\./.test(host) && asin) return `${host}/dp/${asin[1].toUpperCase()}`;
    return `${host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}
