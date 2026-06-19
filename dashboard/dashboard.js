/**
 * Data Center — AI Agent Simulation — admin dashboard logic.
 *
 * Shared by agents/dashboard/admin-panel.html (standalone) and re-used
 * (in spirit — index.html stays a single file) by the in-app Admin tab.
 *
 * Auth model: the admin types their token into the page once; it's stored
 * in localStorage and sent as `X-Admin-Token`. The Worker (agent-runner.js)
 * validates it against env.ADMIN_TOKEN (a server-side secret) — the token
 * is never embedded in shipped JS. See CLAUDE.md credential rules.
 *
 * Status: DRAFT (Phase 1 foundation).
 */

const DCAdmin = (() => {
  // Point this at your deployed agent-runner Worker.
  const API_BASE = 'https://data-center-agents.avivnofar.workers.dev';
  const TOKEN_KEY = 'dc-admin-token';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  async function api(path) {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'X-Admin-Token': getToken() },
    });
    if (res.status === 401) throw new Error('unauthorized');
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  }

  function login() {
    const input = document.getElementById('token-input');
    const token = input.value.trim();
    if (!token) return;
    localStorage.setItem(TOKEN_KEY, token);
    enterDashboard();
  }

  async function enterDashboard() {
    document.getElementById('login').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    try {
      await refresh();
    } catch (err) {
      if (err.message === 'unauthorized') {
        localStorage.removeItem(TOKEN_KEY);
        document.getElementById('login').style.display = 'block';
        document.getElementById('dashboard').style.display = 'none';
        alert('Invalid admin token.');
      }
    }
  }

  async function refresh() {
    const [statuses, sessions] = await Promise.all([
      api('/api/agents/status'),
      api('/api/agents/sessions?limit=50'),
    ]);
    renderAgentGrid(statuses);
    renderFeed(sessions);
    await showReportTab(currentReportTab, null);
  }

  function renderAgentGrid(statuses) {
    const active = statuses.filter((s) => s.status !== 'stub').length;
    document.getElementById('active-count').textContent = active;
    document.getElementById('stub-count').textContent = statuses.length - active;

    const grid = document.getElementById('agent-grid');
    grid.innerHTML = statuses.map((a) => {
      const state = a.isAngry ? 'ANGRY' : a.isPanic ? 'PANIC' : a.isHappy ? 'HAPPY' : a.irritation > 0 ? 'IRRITATED' : 'NEUTRAL';
      const dots = Array.from({ length: 5 }, (_, i) =>
        `<div class="dot${i < a.irritation ? ' lit' : ''}"></div>`
      ).join('');
      const cases = a.session?.cases_handled ?? 0;

      return `
        <div class="card">
          <h3>${escapeHtml(a.name)} <span class="badge ${state}">${state}</span></h3>
          <div class="sub">${escapeHtml(a.role || '')} · ${a.clearance}</div>
          <div class="mood-bar"><div style="width:${a.mood}%"></div></div>
          <div class="sub">Mood ${a.mood}/100</div>
          <div class="dots">${dots}</div>
          <div class="sub">Cases this session: ${cases}${a.status === 'stub' ? ' · stub' : ''}</div>
        </div>`;
    }).join('');
  }

  function renderFeed(sessions) {
    const feed = document.getElementById('feed');
    feed.innerHTML = sessions.map((s) => {
      const ts = new Date(s.timestamp).toISOString().replace('T', ' ').slice(0, 19);
      const summary = (s.response_summary || '').slice(0, 80).replace(/\n/g, ' ');
      return `<div>[${ts}] [${escapeHtml(s.agent_name)}] [${escapeHtml(s.type)}]${s.state_change ? ` (${s.state_change})` : ''} ${escapeHtml(summary)}</div>`;
    }).join('') || '<div class="sub">No interactions logged yet.</div>';
  }

  let currentReportTab = 'incident';

  async function showReportTab(type, btn) {
    currentReportTab = type;
    if (btn) {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    }

    const container = document.getElementById('reports-list');
    try {
      const items = type === 'suggestions'
        ? await api('/api/agents/suggestions')
        : await api(`/api/agents/reports?type=${type}`);

      if (!items.length) {
        container.innerHTML = '<div class="sub">Nothing here yet.</div>';
        return;
      }

      container.innerHTML = items.map((r) => `
        <div class="report-card">
          <h4>${escapeHtml(r.title)} ${r.severity ? `<span class="badge">${escapeHtml(r.severity)}</span>` : ''}${r.permission_level ? `<span class="badge">${escapeHtml(r.permission_level)}</span>` : ''}</h4>
          <div class="sub">${new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19)}</div>
          <pre>${escapeHtml((r.content || '').slice(0, 600))}</pre>
        </div>`).join('');
    } catch (err) {
      container.innerHTML = `<div class="sub">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Auto-enter if a token is already stored.
  if (getToken()) enterDashboard();

  return { login, refresh, showReportTab };
})();
