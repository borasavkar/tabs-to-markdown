/*
 * Tabs to Markdown for AI — sayfa okuyucu.
 *
 * Sekmenin içine enjekte edilir. Sayfayı kullanıcının gördüğü haliyle okur,
 * Markdown'a çevirir ve sonucu arka plana gönderir. Bu dosyadan önce
 * lib/Readability.js ve lib/turndown.js enjekte edilir.
 * Markdown'daki başlıklar, tarih ve sayı biçimi tarayıcının dilindedir.
 */
(() => {
  if (window.__mdCreator) return;

  const api = globalThis.browser ?? globalThis.chrome;
  const LOCALE = api.i18n.getUILanguage();
  const t = (key, ...subs) => api.i18n.getMessage(key, subs.map(String)) || key;

  // ---------------------------------------------------------------- ayarlar

  // Görünümde blok gibi davranıp etiketi satır içi olan öğeler (span, a ...).
  // Bunları div'e çeviriyoruz ki metinler birbirine yapışmasın.
  const INLINE_TAGS = new Set(['A', 'SPAN', 'LABEL', 'EM', 'I', 'B', 'STRONG', 'SMALL', 'FONT', 'U', 'MARK', 'TIME', 'ABBR', 'CITE', 'Q']);

  const DROP_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed',
    'video', 'audio', 'picture', 'img', 'map', 'input', 'select', 'textarea', 'option',
    'datalist', 'meter', 'progress', 'dialog', 'link', 'meta', 'nav',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="dialog"]',
    '[role="alertdialog"]', '[role="menu"]', '[role="menubar"]', '[role="search"]',
    '[aria-modal="true"]',
  ].join(',');

  // id/class içinde bu kelimeler geçen bölümler gürültü sayılır.
  const NOISE_WORDS = new Set([
    'cookie', 'cookies', 'consent', 'onetrust', 'gdpr', 'kvkk', 'newsletter', 'popup', 'modal',
    'overlay', 'toast', 'tooltip', 'advertisement', 'advert', 'adservice', 'adslot', 'sponsored',
    'sponsor', 'recommendation', 'recommendations', 'recommended', 'carousel', 'share', 'social',
  ]);

  // Siteye özel ayarlar. Bölüm bulunamazsa genel yönteme dönülür.
  const SITES = [
    {
      name: 'Amazon',
      host: /(^|\.)amazon\.[a-z.]+$/,
      sections: [
        '#ppd', '#productOverview_feature_div', '#featurebullets_feature_div',
        '#productDescription_feature_div', '#aplus_feature_div', '#prodDetails',
        '#detailBullets_feature_div', '#productDetails_feature_div', '#product-summary',
        '#customer-reviews_feature_div', '#reviewsMedley', '#cm_cr-review_list',
      ],
      remove: [
        '#rightCol', '#leftCol', '#imageBlock_feature_div', '#altImages', '.a-carousel-container',
        '[data-hook*="helpful"]', '[data-hook*="reportAbuse"]', '[data-hook*="Expand"]',
        '[data-hook="translationSpinner"]', '[data-hook*="image"]', '[data-hook="genome-widget"]',
        '.a-price > span[aria-hidden="true"]', '[cel_widget_id*="sponsored"]',
      ],
      // Teknik özellik tabloları kapalı açılır bölmelerde duruyor; gizli olsalar da alınır.
      keepHidden: ['#prodDetails', '#productDetails_feature_div', '#detailBullets_feature_div'],
      product: amazonProduct,
    },
    {
      name: 'Trendyol',
      host: /(^|\.)trendyol\.com$/,
      remove: ['#internal-linking-seo', '.footer'],
    },
    {
      name: 'Hepsiburada',
      host: /(^|\.)hepsiburada\.com$/,
      remove: ['[id^="Advertisement"]', '[id*="googleAdvertisement"]', '[id^="recommendation"]', '#Installments', '#HbFinance'],
    },
    {
      name: 'n11',
      host: /(^|\.)n11\.com$/,
      sections: ['#pdp-head-area', '#webProductDescription', '#pdp-descriptions', '#productAttributes', '#productReviews'],
    },
    // #PL_h satıcı fiyat listesidir; diğer PL_ listeleri "benzer ürünler" vitrinleri.
    { name: 'Akakçe', host: /(^|\.)akakce\.com$/, remove: ['#Thumbs', '[id^="PL_"]:not(#PL_h)'] },
    { name: 'Cimri', host: /(^|\.)cimri\.com$/ },
  ];

  // schema.org stok durumu -> dil dosyasındaki anahtar
  const AVAILABILITY = {
    InStock: 'availInStock', OutOfStock: 'availOutOfStock', SoldOut: 'availSoldOut', PreOrder: 'availPreOrder',
    PreSale: 'availPreSale', BackOrder: 'availBackOrder', LimitedAvailability: 'availLimited',
    Discontinued: 'availDiscontinued', InStoreOnly: 'availInStoreOnly', OnlineOnly: 'availOnlineOnly',
  };

  // ---------------------------------------------------------------- yardımcılar

  const clean = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  const cell = (s) => clean(s).replace(/\|/g, '\\|');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const typesOf = (o) => [].concat((o && o['@type']) || []);
  // Canlı sayfada innerText kullanılır: gizli kopyaları ve gömülü kodu almaz.
  const textOf = (sel, root = document) => {
    const el = root.querySelector(sel);
    return el ? clean(el.innerText ?? el.textContent) : '';
  };
  const meta = (name) =>
    document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content') || '';

  function flatLd(j) {
    if (Array.isArray(j)) return j.flatMap(flatLd);
    if (j && typeof j === 'object') return j['@graph'] ? flatLd(j['@graph']) : [j];
    return [];
  }

  function readJsonLd() {
    const out = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      const raw = s.textContent || '';
      try {
        out.push(...flatLd(JSON.parse(raw)));
      } catch {
        // Bazı siteler metin içinde satır sonu bırakıyor; bir kez de temizleyip deneriz.
        try { out.push(...flatLd(JSON.parse(raw.replace(/[\u0000-\u001F]+/g, ' ')))); } catch { /* bozuk veri, atla */ }
      }
    }
    return out;
  }

  function parseNumber(v) {
    let s = clean(v).replace(/[^\d.,-]/g, '');
    if (!s) return NaN;
    if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
    else if (s.includes(',')) s = s.replace(',', '.');
    return Number(s);
  }

  function fmtPrice(v, currency) {
    const n = parseNumber(v);
    if (!Number.isFinite(n)) return clean(v);
    const cur = currency === 'TL' ? 'TRY' : clean(currency).toUpperCase();
    if (cur) {
      try { return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: cur }).format(n); } catch { /* bilinmeyen para birimi */ }
    }
    const s = n.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return cur ? `${s} ${cur}` : s;
  }

  function fmtCount(v) {
    const n = parseNumber(v);
    return Number.isFinite(n) ? n.toLocaleString(LOCALE) : clean(v);
  }

  const nameOf = (v) => clean(typeof v === 'object' && v ? v.name : v);

  // ---------------------------------------------------------------- ürün bilgisi

  function productFromLd(ld) {
    const p = ld.find((o) => typesOf(o).some((t) => t === 'Product' || t === 'ProductGroup'));
    if (!p) return null;

    const info = {
      name: clean(p.name),
      brand: nameOf(p.brand),
      model: clean(p.model && (p.model.name || p.model)),
      sku: clean(p.sku || p.mpn),
      gtin: clean(p.gtin13 || p.gtin || p.gtin12 || p.gtin8),
      color: clean(p.color),
      category: clean(typeof p.category === 'object' ? p.category?.name : p.category),
      properties: [],
      offers: [],
      reviews: [],
      variants: [],
    };

    // Teklifler: tek teklif, teklif listesi ya da "en düşük / en yüksek" özeti olabilir.
    const offers = [];
    for (const o of [].concat(p.offers || [])) {
      if (typesOf(o).includes('AggregateOffer')) {
        info.lowPrice = o.lowPrice;
        info.highPrice = o.highPrice;
        info.offerCount = o.offerCount;
        info.currency = o.priceCurrency || info.currency;
        offers.push(...[].concat(o.offers || []));
      } else {
        offers.push(o);
      }
    }
    for (const o of offers) {
      const price = o.price ?? o.priceSpecification?.price ?? o.lowPrice;
      if (price == null) continue;
      info.offers.push({
        price,
        currency: o.priceCurrency || o.priceSpecification?.priceCurrency || info.currency,
        seller: nameOf(o.seller),
        host: hostOf(o.url),
        availability: availabilityText(o.availability),
      });
    }
    if (info.offers.length === 1) {
      const o = info.offers[0];
      info.price = fmtPrice(o.price, o.currency);
      info.availability = o.availability;
      info.seller = o.seller;
    } else if (info.offers.length > 1 && info.lowPrice == null) {
      const nums = info.offers.map((o) => parseNumber(o.price)).filter(Number.isFinite);
      info.lowPrice = Math.min(...nums);
      info.highPrice = Math.max(...nums);
      info.currency = info.offers[0].currency;
    }
    if (!info.availability && info.offers[0]) info.availability = info.offers[0].availability;

    const r = p.aggregateRating;
    if (r) {
      info.rating = {
        value: r.ratingValue,
        best: r.bestRating || 5,
        count: r.ratingCount,
        reviews: r.reviewCount,
      };
    }

    for (const ap of [].concat(p.additionalProperty || [])) {
      const k = clean(ap.name);
      let v;
      if (ap.value != null && ap.value !== '') v = ap.unitText ? `${ap.value} ${ap.unitText}` : ap.value;
      else v = ap.unitText ?? ap.valueReference ?? '';
      if (k && clean(v)) info.properties.push([k, clean(v)]);
    }

    // Yorumlar ürünün içinde ya da sayfada ayrı parçalar halinde olabilir.
    const reviews = [].concat(p.review || []);
    reviews.push(...ld.filter((o) => typesOf(o).includes('Review')));
    const seen = new Set();
    for (const rv of reviews) {
      const body = clean(rv.reviewBody || rv.description);
      if (!body || seen.has(body)) continue;
      seen.add(body);
      info.reviews.push({
        rating: rv.reviewRating?.ratingValue,
        best: rv.reviewRating?.bestRating || 5,
        date: clean(rv.datePublished).slice(0, 10),
        title: clean(rv.name),
        body,
      });
    }

    for (const v of [].concat(p.hasVariant || [])) {
      const n = clean(v.name);
      if (n) info.variants.push(n);
    }
    return info;
  }

  function productFromMeta() {
    const amount = meta('product:price:amount') || meta('og:price:amount');
    if (!amount) return null;
    const currency = meta('product:price:currency') || meta('og:price:currency');
    return {
      name: clean(meta('og:title')),
      price: fmtPrice(amount, currency),
      properties: [], offers: [], reviews: [], variants: [],
    };
  }

  function amazonProduct() {
    const ratingTitle = document.querySelector('#acrPopover')?.getAttribute('title') || textOf('#acrPopover');
    return {
      name: textOf('#productTitle'),
      brand: textOf('#bylineInfo')
        .replace(/^(Marka:|Ziyaret edin:?|Visit the)\s*/i, '')
        .replace(/\s*(Store[’']u|Mağazasını)?\s*ziyaret edin$/i, '')
        .replace(/\s*(Mağazası|Store)$/i, ''),
      priceText: textOf('#corePrice_feature_div .a-offscreen') || textOf('#corePriceDisplay_desktop_feature_div .a-offscreen') || textOf('#apex_desktop .a-offscreen'),
      ratingText: clean(ratingTitle),
      ratingCountText: textOf('#acrCustomerReviewText').replace(/[()]/g, ''),
      availability: textOf('#availability'),
      seller: textOf('#merchantInfoFeature_feature_div .offer-display-feature-text') || textOf('#merchant-info'),
      properties: [], offers: [], reviews: [], variants: [],
    };
  }

  function availabilityText(v) {
    const key = clean(v).split('/').pop();
    return AVAILABILITY[key] ? t(AVAILABILITY[key]) : key;
  }

  function hostOf(url) {
    try { return new URL(url, location.href).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  function productMarkdown(info) {
    const rows = [];
    const add = (k, v) => { if (clean(v)) rows.push(`| ${t(k)} | ${cell(v)} |`); };
    add('mdProduct', info.name);
    add('mdBrand', info.brand);
    add('mdModel', info.model);
    add('mdColor', info.color);
    add('mdCategory', info.category);
    add('mdPrice', info.price || info.priceText);
    if (info.lowPrice != null) {
      const range = info.highPrice != null && parseNumber(info.highPrice) !== parseNumber(info.lowPrice)
        ? `${fmtPrice(info.lowPrice, info.currency)} – ${fmtPrice(info.highPrice, info.currency)}`
        : fmtPrice(info.lowPrice, info.currency);
      add('mdPriceRange', info.offerCount ? `${range} (${t('mdOffers', fmtCount(info.offerCount))})` : range);
    }
    add('mdStock', info.availability);
    add('mdSeller', info.seller);
    if (info.rating) {
      const value = Number.isFinite(parseNumber(info.rating.value)) ? parseNumber(info.rating.value).toLocaleString(LOCALE) : clean(info.rating.value);
      const parts = [`${value} / ${info.rating.best}`];
      if (info.rating.count) parts.push(t('mdVotes', fmtCount(info.rating.count)));
      if (info.rating.reviews) parts.push(t('mdReviewCount', fmtCount(info.rating.reviews)));
      add('mdRating', parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0]);
    } else if (info.ratingText) {
      add('mdRating', info.ratingCountText ? `${info.ratingText} (${t('mdVotes', info.ratingCountText)})` : info.ratingText);
    }
    add('mdSku', info.sku);
    add('mdGtin', info.gtin);

    let md = '';
    if (rows.length) {
      md += `## ${t('mdProductSummary')}\n\n_${t('mdFromStructured')}_\n\n`;
      md += `| ${t('mdField')} | ${t('mdValue')} |\n| --- | --- |\n${rows.join('\n')}\n\n`;
    }

    if (info.properties.length) {
      md += `### ${t('mdSpecs')}\n\n| ${t('mdSpec')} | ${t('mdValue')} |\n| --- | --- |\n`;
      md += info.properties.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`).join('\n') + '\n\n';
    }

    if (info.offers.length > 1) {
      const list = info.offers
        .filter((o) => Number.isFinite(parseNumber(o.price)))
        .sort((a, b) => parseNumber(a.price) - parseNumber(b.price))
        .slice(0, 30);
      md += `### ${t('mdSellerPrices', list.length)}\n\n| ${t('mdSeller')} | ${t('mdPrice')} | ${t('mdStock')} |\n| --- | --- | --- |\n`;
      md += list.map((o) => `| ${cell(o.seller || o.host || '-')} | ${cell(fmtPrice(o.price, o.currency))} | ${cell(o.availability || '')} |`).join('\n') + '\n\n';
    }

    if (info.variants.length) {
      md += `### ${t('mdVariants')}\n\n${info.variants.slice(0, 30).map((v) => `- ${v}`).join('\n')}\n\n`;
    }

    if (info.reviews.length) {
      const list = info.reviews.slice(0, 30);
      md += `### ${t('mdReviewSamples', list.length)}\n\n`;
      md += list.map((r) => {
        const head = [r.rating != null ? t('mdRatingOutOf', r.rating, r.best) : '', r.date].filter(Boolean).join(' · ');
        const title = r.title && r.title !== r.body ? `${r.title}: ` : '';
        return `- ${head ? `(${head}) ` : ''}${title}${r.body}`;
      }).join('\n') + '\n\n';
    }
    return md;
  }

  // ---------------------------------------------------------------- içerik seçimi

  function pickMain() {
    const bodyLen = clean(document.body.innerText).length || 1;
    const cands = [...document.querySelectorAll('main, [role="main"], article, #content, #main')];
    let best = null;
    let bestLen = 0;
    for (const el of cands) {
      const len = clean(el.innerText).length;
      if (len > bestLen) { best = el; bestLen = len; }
    }
    if (best && bestLen >= 500 && bestLen / bodyLen >= 0.3) return [best];
    return [document.body];
  }

  function pickSections(selectors) {
    const found = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (found.some((f) => f.contains(el))) continue;
        for (let i = found.length - 1; i >= 0; i--) if (el.contains(found[i])) found.splice(i, 1);
        found.push(el);
      }
    }
    // Belge sırasına diz.
    found.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return found;
  }

  // Gizli olsa da alınacak öğeler: siteye özel bölümler ve kapalı bölmelerdeki
  // özellik tabloları (en az üç satırlı tablo).
  function keepHiddenFn(site) {
    const sel = site?.keepHidden?.join(',');
    return (el) => (sel && el.closest(sel)) || !!el.querySelector('table tr:nth-child(3)');
  }

  // Canlı sayfadaki görünürlük bilgisini kopyaya taşır: gizli öğeleri siler,
  // blok gibi görünen satır içi öğeleri div'e çevirir.
  function cloneVisible(liveRoot, inert, keepHidden) {
    const copy = inert.importNode(liveRoot, true);
    const live = liveRoot.querySelectorAll('*');
    const dead = copy.querySelectorAll('*');
    if (live.length !== dead.length) return copy; // sayfa o an değişti; işaretlemeden devam
    const toRemove = [];
    const toBlock = [];
    for (let i = 0; i < live.length; i++) {
      const cs = getComputedStyle(live[i]);
      if (cs.display === 'none' || cs.visibility === 'hidden') {
        if (!keepHidden(live[i])) toRemove.push(dead[i]);
      } else if (INLINE_TAGS.has(live[i].tagName) && !cs.display.startsWith('inline') && cs.display !== 'contents') {
        toBlock.push(dead[i]);
      }
    }
    for (const el of toBlock) {
      const d = inert.createElement('div');
      if (el.tagName === 'A') d.setAttribute('data-mdc-link', ''); // link yoğunluğu hesabı için
      while (el.firstChild) d.appendChild(el.firstChild);
      el.replaceWith(d);
    }
    for (const el of toRemove) el.remove();
    return copy;
  }

  function isNoise(el) {
    const words = `${el.id || ''} ${el.getAttribute('class') || ''}`
      .split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/)
      .map((w) => w.toLowerCase());
    return words.some((w) => NOISE_WORDS.has(w));
  }

  function linkHeavy(el) {
    if (el.querySelector('h1')) return false;
    const text = clean(el.textContent);
    if (text.length < 80) return false;
    const links = el.querySelectorAll('a, [data-mdc-link]');
    if (links.length < 6) return false;
    let linkLen = 0;
    for (const a of links) linkLen += clean(a.textContent).length;
    return linkLen / text.length > 0.6 && linkLen / links.length < 35;
  }

  // "Etiket / değer" çiftlerinden oluşan listeleri "Etiket: değer" satırına çevirir.
  function pairRows(wrapper, inert) {
    for (const parent of wrapper.querySelectorAll('ul, ol, div, section')) {
      const kids = [...parent.children];
      if (kids.length < 3) continue;
      const pairs = kids.map((k) => {
        const c = [...k.children];
        if (c.length !== 2) return null;
        if (c.some((x) => x.querySelector('div, p, ul, ol, table, h1, h2, h3, h4'))) return null;
        const a = clean(c[0].textContent);
        const b = clean(c[1].textContent);
        if (!a || !b || a.length > 60 || b.length > 160) return null;
        return [a.replace(/:$/, ''), b];
      });
      const ok = pairs.filter(Boolean).length;
      if (ok < 3 || ok / kids.length < 0.8) continue;
      kids.forEach((k, i) => {
        if (!pairs[i]) return;
        const p = inert.createElement('p');
        p.textContent = `${pairs[i][0]}: ${pairs[i][1]}`;
        k.replaceWith(p);
      });
    }
  }

  function cleanup(wrapper, inert, site, bodyRoot) {
    wrapper.querySelectorAll(DROP_SELECTOR).forEach((el) => el.remove());
    if (site?.remove) {
      for (const sel of site.remove) {
        try { wrapper.querySelectorAll(sel).forEach((el) => el.remove()); } catch { /* geçersiz seçici */ }
      }
    }
    if (bodyRoot) {
      wrapper.querySelectorAll('header, footer').forEach((el) => { if (!el.closest('article, main')) el.remove(); });
    }
    for (const el of wrapper.querySelectorAll('[id], [class]')) {
      if (wrapper.contains(el) && el.tagName !== 'MAIN' && isNoise(el)) el.remove();
    }
    for (const b of wrapper.querySelectorAll('button, [role="button"], [role="tab"]')) {
      if (!wrapper.contains(b)) continue;
      const t = clean(b.textContent);
      if (t.length > 200) continue; // düğme gibi davranan büyük kartlara dokunma
      const label = t.length > 2 && (b.hasAttribute('aria-expanded') || b.hasAttribute('aria-controls') || b.getAttribute('role') === 'tab');
      if (label) {
        const p = inert.createElement('p');
        p.textContent = t;
        b.replaceWith(p);
      } else if (b.tagName === 'BUTTON' || t.length < 40) {
        b.remove();
      }
    }
    // Menü ve "popüler aramalar" gibi kısa linklerden oluşan blokları alttan yukarı temizle.
    const blocks = [...wrapper.querySelectorAll('ul, ol, div, section, aside, header, footer')].reverse();
    for (const el of blocks) {
      if (wrapper.contains(el) && !el.closest('table, dl') && linkHeavy(el)) el.remove();
    }
    pairRows(wrapper, inert);
  }

  // ---------------------------------------------------------------- Markdown

  function tableToMd(table) {
    const allRows = [...table.rows];
    if (!allRows.length) return '';
    const rows = allRows.map((r) => [...r.cells].map((c) => cell(c.textContent)));
    const width = Math.max(...rows.map((r) => r.length));
    const nonEmpty = rows.filter((r) => r.some(Boolean));
    if (!nonEmpty.length) return '';
    if (width === 1) return nonEmpty.map((r) => r[0]).join('\n\n');

    let header;
    const first = allRows[0];
    const firstIsHeader = table.tHead?.rows.length || [...first.cells].every((c) => c.tagName === 'TH');
    let body = rows;
    if (firstIsHeader && rows[0].some(Boolean)) {
      header = rows[0];
      body = rows.slice(1);
    } else if (width === 2) {
      header = [t('mdSpec'), t('mdValue')];
    } else {
      header = Array.from({ length: width }, (_, i) => t('mdColumn', i + 1));
    }
    const pad = (r) => Array.from({ length: width }, (_, i) => r[i] || '');
    const lines = [pad(header), Array(width).fill('---'), ...body.filter((r) => r.some(Boolean)).map(pad)];
    return lines.map((r) => `| ${r.join(' | ')} |`).join('\n');
  }

  function dlToMd(dl) {
    const out = [];
    let key = '';
    for (const el of dl.children) {
      if (el.tagName === 'DT') key = clean(el.textContent);
      else if (el.tagName === 'DD') out.push(`- ${key ? `${key}: ` : ''}${clean(el.textContent)}`);
    }
    return out.join('\n');
  }

  function makeTurndown() {
    const td = new TurndownService({ headingStyle: 'atx', hr: '---', bulletListMarker: '-', codeBlockStyle: 'fenced' });
    td.escape = (s) => s; // Yapay zeka için kaçış işaretleri yalnızca gürültü olur.
    // Turndown'un kendi resim kuralı remove()'dan önce çalıştığı için resimler ayrı bir kuralla atılır.
    td.addRule('dropMedia', {
      filter: ['img', 'picture', 'svg', 'video', 'audio', 'canvas', 'iframe', 'object', 'embed', 'button', 'input', 'select', 'textarea'],
      replacement: () => '',
    });
    td.remove(['script', 'style', 'noscript', 'template']);
    td.addRule('plainLinks', { filter: 'a', replacement: (c) => c });
    td.addRule('plainInline', {
      filter: ['em', 'i', 'strong', 'b', 'u', 'mark', 'small', 'span', 'font', 'cite', 'abbr', 'time', 'label'],
      replacement: (c) => c,
    });
    td.addRule('table', { filter: 'table', replacement: (c, node) => `\n\n${tableToMd(node)}\n\n` });
    td.addRule('dl', { filter: 'dl', replacement: (c, node) => `\n\n${dlToMd(node)}\n\n` });
    return td;
  }

  function tidy(md) {
    const lines = md.split('\n').map((l) => l.replace(/[ \t ]+$/g, ''));
    const out = [];
    for (const line of lines) {
      if (/^#{1,6}\s*$/.test(line)) continue; // boş başlık
      const prev = out.length ? out[out.length - 1] : null;
      if (line && line === prev) continue; // art arda tekrar eden satır
      // Aynı satır bir boş satır arayla da tekrarlanıyorsa at.
      if (line && prev === '' && out.length > 1 && out[out.length - 2] === line) continue;
      out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------------------------------------------------------------- akış

  async function autoScroll() {
    const startY = window.scrollY;
    let lastHeight = 0;
    for (let i = 0; i < 10; i++) {
      window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'instant' });
      await sleep(350);
      const h = document.documentElement.scrollHeight;
      if (window.innerHeight + window.scrollY >= h - 5) {
        if (h === lastHeight) break;
        lastHeight = h;
      }
    }
    window.scrollTo({ top: startY, behavior: 'instant' });
    await sleep(300);
  }

  function looksBlocked() {
    const t = document.title || '';
    if (/just a moment|attention required|bir dakika|robot musunuz|captcha|access denied|erişim engellendi/i.test(t)) return true;
    const body = clean(document.body?.innerText);
    if (body.length >= 600) return false;
    // Kısa sayfada başlık "Güvenlik" ya da metin doğrulama istiyorsa bu bir engel ekranıdır.
    return /güvenlik|security check|doğrulama/i.test(t)
      || /cloudflare|captcha|robot olmadığınızı|i'm not a robot|verify you are human|güvenlik doğrulaması|olağan dışı trafik|unusual traffic/i.test(body);
  }

  function siteName(site) {
    return site?.name || clean(meta('og:site_name')) || location.hostname.replace(/^www\./, '');
  }

  function convertContent(roots, site, mode) {
    const inert = document.implementation.createHTMLDocument('');
    const td = makeTurndown();

    if (mode !== 'full' && typeof Readability !== 'undefined') {
      const wantReader = mode === 'reader' || !roots.product;
      if (wantReader) {
        try {
          const article = new Readability(document.cloneNode(true), { charThreshold: 300 }).parse();
          const len = clean(article?.textContent).length;
          const mainLen = clean(roots.els.map((e) => e.innerText).join(' ')).length;
          // Forum ve yorum sayfalarında okuma görünümü sadece ilk mesajı alabiliyor;
          // sayfanın çok küçük bir kısmını aldıysa tüm sayfaya dönüyoruz.
          if (article && len >= 300 && (mode === 'reader' || mainLen < 2000 || len / mainLen >= 0.4)) {
            const doc = new DOMParser().parseFromString(article.content, 'text/html');
            return { md: td.turndown(doc.body), method: t('methodReader') };
          }
        } catch { /* okuma görünümü başarısız; tüm sayfaya geç */ }
      }
    }

    const wrapper = inert.createElement('div');
    const keepHidden = keepHiddenFn(site);
    for (const el of roots.els) wrapper.appendChild(cloneVisible(el, inert, keepHidden));
    cleanup(wrapper, inert, site, roots.els.length === 1 && roots.els[0] === document.body);
    return { md: td.turndown(wrapper), method: roots.method };
  }

  async function extract(opts = {}) {
    if (opts.scroll) await autoScroll();
    if (looksBlocked()) {
      return { ok: false, blocked: true, url: location.href, title: document.title, error: t('errBlocked') };
    }

    const site = SITES.find((s) => s.host.test(location.hostname));
    const ld = readJsonLd();
    let info = productFromLd(ld) || productFromMeta();
    if (site?.product) {
      const dom = site.product();
      info = info ? { ...dom, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))) } : (dom.name ? dom : null);
    }

    let els = site?.sections ? pickSections(site.sections) : [];
    let method = t('methodSite');
    if (!els.length) {
      els = pickMain();
      method = els[0] === document.body ? t('methodFull') : t('methodMain');
    }

    const { md: content, method: used } = convertContent({ els, method, product: !!info }, site, opts.mode || 'auto');

    const title = info?.name || clean(document.querySelector('h1')?.textContent) || clean(document.title);
    const site_ = siteName(site);
    const when = new Date().toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' });

    let md = `# ${title}\n\n`;
    md += `- ${t('mdSite')}: ${site_}\n- ${t('mdAddress')}: ${location.href}\n- ${t('savedAt')}: ${when}\n`;
    if (document.title && clean(document.title) !== title) md += `- ${t('mdPageTitle')}: ${clean(document.title)}\n`;
    md += '\n';
    if (info) md += productMarkdown(info);
    md += `## ${t('mdPageContent')}\n\n_${t('mdMethod', used)}_\n\n${content}\n`;
    md = tidy(md) + '\n';

    return { ok: true, url: location.href, title, site: site_, markdown: md, chars: md.length, method: used, product: !!info };
  }

  window.__mdCreator = { extract };

  // Arka plan "mdc-run" mesajı gönderir; cevap olarak Markdown sonucu döner.
  // sendResponse + "return true" hem Firefox'ta hem Chrome'da çalışır.
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'mdc-run') return false;
    extract(msg.opts)
      .catch((e) => ({ ok: false, url: location.href, title: document.title, error: t('errRead', e?.message || e) }))
      .then(sendResponse);
    return true;
  });
})();
