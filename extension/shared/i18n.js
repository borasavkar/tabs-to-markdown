/*
 * Eklenti sayfaları (pencere, tanıtım sayfası) için ortak dil yardımcısı.
 * Metinler _locales/<dil>/messages.json dosyalarından, tarayıcının diline göre gelir.
 */
const api = globalThis.browser ?? globalThis.chrome;
const LOCALE = api.i18n.getUILanguage();
const t = (key, ...subs) => api.i18n.getMessage(key, subs.map(String)) || key;

// data-i18n="anahtar" → metin, data-i18n-placeholder="anahtar" → yer tutucu.
// Arapça gibi sağdan sola yazılan dillerde sayfa yönü de çevrilir.
function localizePage(root = document) {
  document.documentElement.lang = LOCALE;
  document.documentElement.dir = api.i18n.getMessage('@@bidi_dir') || 'ltr';
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}
