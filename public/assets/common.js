'use strict';
const FD = {
  role: ({ '/': 'admin', '/index.html': 'admin', '/shop-app.html': 'shop', '/Rider-App.html': 'rider' })[location.pathname] || '',
  async api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), 'X-FD-Role': this.role, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  },
  async login(role, code, extra = {}) { return this.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ role, code, ...extra }) }); },
  async logout(role) { return this.api('/api/auth/logout', { method: 'POST', body: JSON.stringify({ role }), headers: { 'X-FD-Role': role } }); },
  async me(role) { return this.api('/api/auth/me', { headers: role ? { 'X-FD-Role': role } : {} }); },
  money(value) { return new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' }).format(Number(value || 0)); },
  esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  status(value) { return ({ new: 'Νέα', accepted: 'Αποδεκτή από κατάστημα', ready: 'Έτοιμη για διανομή', assigned: 'Ανατέθηκε σε διανομέα', picked_up: 'Παραλήφθηκε', delivered: 'Παραδόθηκε', cancelled: 'Ακυρώθηκε' })[value] || value; },
  notice(id, message, error = false) { const node = document.getElementById(id); if (!node) return; node.textContent = message; node.className = error ? 'notice error' : 'notice'; node.classList.toggle('hidden', !message); }
};
