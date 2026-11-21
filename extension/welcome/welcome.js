/*
 * Tanıtım sayfası: sitelere erişim iznini ister.
 * İzin isteği kullanıcının tıklamasının içinde, beklemeden çağrılmalıdır (Firefox kuralı).
 */

const ALL_SITES = { origins: ['<all_urls>'] };

localizePage();

const grant = document.getElementById('grant');
const status = document.getElementById('status');

function showStatus(ok) {
  status.hidden = false;
  status.className = `status ${ok ? 'ok' : 'bad'}`;
  status.textContent = t(ok ? 'permGranted' : 'permDenied');
  grant.hidden = ok;
}

api.permissions.contains(ALL_SITES).then((ok) => { if (ok) showStatus(true); });

grant.addEventListener('click', () => {
  api.permissions.request(ALL_SITES).then(showStatus, () => showStatus(false));
});
