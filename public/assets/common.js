'use strict';
const FD = {
  async api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), 'X-FD-Role': sessionStorage.getItem('fd_role') || '', ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  },
  async login(role, code) { const result = await this.api('/api/auth/login', { method: 'POST', body: JSON.stringify({ role, code }) }); sessionStorage.setItem('fd_role', role); return result; },
  async logout(role) { const result = await this.api('/api/auth/logout', { method: 'POST', body: JSON.stringify({ role }), headers: { 'X-FD-Role': role } }); if (sessionStorage.getItem('fd_role') === role) sessionStorage.removeItem('fd_role'); return result; },
  async me(role) { return this.api('/api/auth/me', { headers: role ? { 'X-FD-Role': role } : {} }); },
  money(value) { return new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' }).format(Number(value || 0)); },
  esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  status(value) { return ({ new: 'Νέα', accepted: 'Αποδεκτή από κατάστημα', ready: 'Έτοιμη για διανομή', assigned: 'Ανατέθηκε σε διανομέα', picked_up: 'Παραλήφθηκε', delivered: 'Παραδόθηκε', cancelled: 'Ακυρώθηκε' })[value] || value; },
  notice(id, message, error = false) { const node = document.getElementById(id); if (!node) return; node.textContent = message; node.className = error ? 'notice error' : 'notice'; node.classList.toggle('hidden', !message); }
};
