(() => {
  'use strict';

  // ----- THEME TOGGLE (persisted) -----
  const THEME_KEY = 'theme'; // 'system' | 'light' | 'dark'
  const VARS_LIGHT = {
    '--bg': '#f8fafc',
    '--surface': '#ffffff',
    '--text': '#0f172a',
    '--muted': '#475569',
    '--border': '#e5e7eb',
    '--primary': '#2563eb',
    '--primary-600': '#1d4ed8',
    '--danger': '#dc2626',
    '--danger-600': '#b91c1c',
    '--success': '#16a34a',
    '--warn': '#d97706',
    '--radius': '8px',
    '--shadow-sm': '0 1px 2px rgba(0,0,0,0.06)',
    '--shadow': '0 6px 24px rgba(0,0,0,0.08)'
  };
  const VARS_DARK = {
    '--bg': '#0b1220',
    '--surface': '#0f172a',
    '--text': '#e5e7eb',
    '--muted': '#94a3b8',
    '--border': '#1f2937',
    '--primary': '#60a5fa',
    '--primary-600': '#93c5fd',
    '--danger': '#ef4444',
    '--danger-600': '#f87171',
    '--success': '#22c55e',
    '--warn': '#f59e0b',
    '--shadow-sm': '0 1px 2px rgba(0,0,0,0.3)',
    '--shadow': '0 6px 24px rgba(0,0,0,0.35)'
  };

  const ready = (fn) =>
    document.readyState !== 'loading'
      ? fn()
      : document.addEventListener('DOMContentLoaded', fn);

  function setVars(map) {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(map)) root.style.setProperty(k, v);
  }
  function clearVars() {
    const root = document.documentElement;
    for (const k of Object.keys(VARS_LIGHT)) root.style.removeProperty(k);
    for (const k of Object.keys(VARS_DARK)) root.style.removeProperty(k);
  }
  function getTheme() {
    return localStorage.getItem(THEME_KEY) || 'system';
  }
  function saveTheme(t) {
    localStorage.setItem(THEME_KEY, t);
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    if (theme === 'light') {
      setVars(VARS_LIGHT);
    } else if (theme === 'dark') {
      setVars(VARS_DARK);
    } else {
      // system default -> rely on CSS + prefers-color-scheme
      clearVars();
    }
    updateToggleLabel(theme);
  }
  function cycleTheme() {
    const order = ['system', 'light', 'dark'];
    const current = getTheme();
    const next = order[(order.indexOf(current) + 1) % order.length];
    saveTheme(next);
    applyTheme(next);
  }
  function themeIcon(theme) {
    if (theme === 'light') return '🌞';
    if (theme === 'dark') return '🌙';
    return '🖥️';
  }
  function themeText(theme) {
    if (theme === 'light') return 'Light';
    if (theme === 'dark') return 'Dark';
    return 'System';
  }
  function updateToggleLabel(theme) {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.textContent = `${themeIcon(theme)} ${themeText(theme)}`;
    btn.setAttribute('title', `Theme: ${themeText(theme)} (click to change)`);
    btn.setAttribute('aria-label', `Theme: ${themeText(theme)} (click to change)`);
  }
  function insertThemeToggle() {
    if (document.getElementById('themeToggle')) return;
    const nav = document.querySelector('nav');
    if (!nav) return;
    const btn = document.createElement('button');
    btn.id = 'themeToggle';
    btn.type = 'button';
    btn.className = 'btn btn-text';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      cycleTheme();
    });
    const right = nav.querySelector('.right');
    if (right && right.parentNode) {
      nav.insertBefore(btn, right);
    } else {
      nav.appendChild(btn);
    }
    updateToggleLabel(getTheme());
  }
  // Refresh theme if OS preference changes and we're on 'system'
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getTheme() === 'system') applyTheme('system');
    });
  } catch {}

  // ----- NAV ACTIVE HIGHLIGHT -----
  function setActiveNav() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    document.querySelectorAll('nav a[href]').forEach((a) => {
      const href = (a.getAttribute('href') || '').replace(/\/+$/, '') || '/';
      if (href === path || (href !== '/' && path.startsWith(href))) {
        a.classList.add('active');
      }
    });
  }

  // ----- AUTO-DISMISS ALERTS -----
  function autoDismissAlerts(ms = 4000) {
    document.querySelectorAll('.success, .error').forEach((el) => {
      let t = setTimeout(() => fadeOut(el), ms);
      el.addEventListener('click', () => {
        clearTimeout(t);
        fadeOut(el);
      });
    });
  }
  function fadeOut(el) {
    el.style.transition = 'opacity .15s ease, transform .15s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-2px)';
    setTimeout(() => el.remove(), 180);
  }

  // ----- PREVENT DOUBLE SUBMITS -----
  function preventDoubleSubmit() {
    document.querySelectorAll('form').forEach((form) => {
      form.addEventListener('submit', () => {
        if (form.dataset.submitted) return;
        form.dataset.submitted = '1';
        form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach((b) => (b.disabled = true));
      });
    });
  }

  // ----- data-confirm helper (optional in markup) -----
  function wireDataConfirm() {
    // Links/buttons with data-confirm
    document.body.addEventListener('click', (e) => {
      const el = e.target.closest('[data-confirm]');
      if (!el) return;
      const msg = el.getAttribute('data-confirm') || 'Are you sure?';
      if (!confirm(msg)) e.preventDefault();
    });
    // Forms with data-confirm
    document.querySelectorAll('form[data-confirm]').forEach((form) => {
      form.addEventListener('submit', (e) => {
        const msg = form.getAttribute('data-confirm') || 'Are you sure?';
        if (!confirm(msg)) e.preventDefault();
      });
    });
  }

  // ----- INIT -----
  const init = () => {
    applyTheme(getTheme());
    insertThemeToggle();

    setActiveNav();
    autoDismissAlerts();
    preventDoubleSubmit();
    wireDataConfirm();
  };

  // Defer ensures DOM is parsed, but in case it's inline, keep ready guard
  ready(init);
})();