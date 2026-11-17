'use strict';
(() => {
  const role = document.body?.dataset.appRole;
  if (!['shop','rider','admin'].includes(role)) return;
  const scope = '/app/' + role + '/';
  const isScoped = location.pathname.startsWith(scope);
  const isInstalled = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const names = { shop: 'Κατάστημα', rider: 'Διανομέας', admin: 'Διαχείριση' };
  if (isScoped) document.body.classList.add('role-standalone');
  if (isScoped && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register(scope + 'sw.js', { scope }).catch(error => console.warn('PWA:', error));
  }
  if (isInstalled) return;
  let prompt = null;
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); prompt=event; });
  const hero = document.querySelector('.hero') || document.querySelector('.top');
  if (!hero) return;
  const bar = document.createElement('aside');
  bar.className='install-card';
  const label = document.createElement('div');
  label.innerHTML='<strong>Fair Delivery ' + names[role] + '</strong><span>Ξεχωριστό εικονίδιο στην αρχική οθόνη, χωρίς να μπλέκονται οι ρόλοι.</span>';
  const button = document.createElement('button');
  button.className='install-button';
  button.textContent='Εγκατάσταση εφαρμογής';
  const note = document.createElement('small');
  note.className='install-help hidden';
  const group = document.createElement('div');
  group.className='install-actions';
  group.append(button,note);
  bar.append(label,group);
  hero.insertAdjacentElement('afterend',bar);
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
  window.addEventListener('appinstalled',()=>bar.remove());
})();
