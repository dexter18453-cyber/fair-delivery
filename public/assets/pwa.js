'use strict';
(() => {
  const role = document.body?.dataset.appRole;
  if (!['shop','rider','admin','customer'].includes(role)) return;
  const scope = '/app/' + role + '/';
  const isScoped = location.pathname.startsWith(scope);
  const isInstalled = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const names = { shop: 'Κατάστημα', rider: 'Διανομέας', admin: 'Διαχείριση', customer: 'Πελάτης' };
  if (isScoped) document.body.classList.add('role-standalone');
  if (isScoped && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register(scope + 'sw.js', { scope }).catch(error => console.warn('PWA:', error));
  }
  if (isInstalled) return;
  let prompt = null;
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); prompt=event; });
  const header = document.querySelector('.top');
  if (!header) return;
  const button = document.createElement('button');
  button.className = 'secondary install-action';
  button.textContent = 'Εγκατάσταση';
  button.setAttribute('aria-label', 'Εγκατάσταση εφαρμογής Fair Delivery ' + names[role]);
  const note = document.createElement('p');
  note.className = 'install-help hidden';
  note.setAttribute('role', 'status');
  header.append(button);
  header.insertAdjacentElement('afterend', note);
  button.addEventListener('click',async()=>{
    if (!isScoped) { location.href=scope; return; }
    if (prompt) {
      prompt.prompt();
      await prompt.userChoice;
      prompt=null;
      return;
    }
    const ios=/iPad|iPhone|iPod/.test(navigator.userAgent);
    note.textContent = ios
      ? 'Στο Safari πάτησε Κοινή χρήση → Προσθήκη στην οθόνη Αφετηρίας.'
      : 'Άνοιξε το μενού του browser και επίλεξε Εγκατάσταση εφαρμογής ή Προσθήκη στην αρχική οθόνη.';
    note.classList.remove('hidden');
  });
  window.addEventListener('appinstalled',()=>{ button.remove(); note.remove(); });
})();
