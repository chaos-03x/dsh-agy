/**
 * Web dashboard HTML/CSS/JS generator for dsh-agy.
 * Follows DeepSeek Harness (DSH) design system tokens and UX conventions.
 */

import { I18N_DICT } from './i18n.ts'

export function renderDashboardHtml(): string {
  const i18nJson = JSON.stringify(I18N_DICT)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agy — Antigravity Accounts</title>
  <style>
    /* DSH Design System Tokens snapshot (ui-theme / design-platform) */
    :root {
      color-scheme: light dark;
      --dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
      --ds-font-family-code: 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, monospace;
      --ds-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
      --ds-transition-fast: 0.12s var(--ds-ease-in-out);
      --ds-transition-normal: 0.2s var(--ds-ease-in-out);

      /* Light Theme Defaults */
      --bg-page: #f8fafc;
      --bg-surface: #ffffff;
      --bg-surface-elevated: #f1f5f9;
      --bg-surface-hover: #f1f5f9;
      --bg-input: #ffffff;
      --border-l1: rgba(0, 0, 0, 0.06);
      --border-l2: rgba(0, 0, 0, 0.12);
      --border-l3: rgba(0, 0, 0, 0.2);
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-tertiary: #94a3b8;
      --text-dimmed: #cbd5e1;

      --brand-primary: #4176e6;
      --brand-hover: #3362c4;
      --brand-surface: rgba(65, 118, 230, 0.1);
      
      --state-success: #22c55e;
      --state-success-bg: rgba(34, 197, 94, 0.12);
      --state-warn: #f59e0b;
      --state-warn-bg: rgba(245, 158, 11, 0.12);
      --state-error: #ef4444;
      --state-error-bg: rgba(239, 68, 68, 0.12);
      
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg-page: #0f1115;
        --bg-surface: #171a21;
        --bg-surface-elevated: #20242e;
        --bg-surface-hover: #262b37;
        --bg-input: #12141a;
        --border-l1: rgba(255, 255, 255, 0.06);
        --border-l2: rgba(255, 255, 255, 0.12);
        --border-l3: rgba(255, 255, 255, 0.22);
        --text-primary: #f8fafc;
        --text-secondary: #94a3b8;
        --text-tertiary: #64748b;
        --text-dimmed: #475569;

        --brand-primary: #5686fe;
        --brand-hover: #4176e6;
        --brand-surface: rgba(86, 134, 254, 0.15);

        --state-success: #34d399;
        --state-success-bg: rgba(52, 211, 153, 0.15);
        --state-warn: #fbbf24;
        --state-warn-bg: rgba(251, 191, 36, 0.15);
        --state-error: #f87171;
        --state-error-bg: rgba(248, 113, 113, 0.15);

        --shadow-sm: 0 1px 3px 0 rgba(0, 0, 0, 0.4);
        --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.5);
        --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.6);
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--dsw-font-family);
      background-color: var(--bg-page);
      color: var(--text-primary);
      line-height: 1.5;
      font-size: 14px;
      padding: 24px 16px;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 1080px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border-l1);
    }
    .header-title-group h1 {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .header-title-group p {
      font-size: 13px;
      color: var(--text-secondary);
      margin-top: 2px;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Buttons (DSH Capsule Geometry) */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      line-height: 20px;
      height: 32px;
      padding: 0 12px;
      border-radius: 16px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background-color var(--ds-transition-fast), border-color var(--ds-transition-fast), color var(--ds-transition-fast), opacity var(--ds-transition-fast);
      white-space: nowrap;
      user-select: none;
    }
    .btn:disabled {
      cursor: not-allowed;
      opacity: 0.45 !important;
    }
    .btn-sm {
      height: 26px;
      font-size: 12px;
      padding: 0 9px;
      border-radius: 13px;
    }
    .btn-primary {
      background: var(--brand-primary);
      color: #ffffff;
    }
    .btn-primary:hover:not(:disabled) {
      background: var(--brand-hover);
    }
    .btn-secondary {
      background: transparent;
      border-color: var(--border-l2);
      color: var(--text-primary);
    }
    .btn-secondary:hover:not(:disabled) {
      background: var(--bg-surface-hover);
      border-color: var(--border-l3);
    }
    .btn-cta {
      background: var(--state-warn-bg);
      border-color: var(--state-warn);
      color: var(--state-warn);
      font-weight: 600;
      animation: pulse-border 2s infinite;
    }
    .btn-cta:hover:not(:disabled) {
      background: var(--state-warn);
      color: #ffffff;
    }
    @keyframes pulse-border {
      0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.4); }
      50% { box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.15); }
    }
    .btn-danger {
      background: transparent;
      border-color: var(--border-l2);
      color: var(--state-error);
    }
    .btn-danger:hover:not(:disabled) {
      background: var(--state-error-bg);
      border-color: var(--state-error);
    }

    /* Master-Detail Layout */
    .main-grid {
      display: grid;
      grid-template-columns: 290px 1fr;
      gap: 20px;
      align-items: start;
    }
    @media (max-width: 780px) {
      .main-grid {
        grid-template-columns: 1fr;
      }
    }

    /* Cards */
    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-l2);
      border-radius: 12px;
      padding: 16px;
      box-shadow: var(--shadow-sm);
    }
    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* Account List (Master) */
    .account-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      list-style: none;
    }
    .account-item {
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--border-l1);
      background: var(--bg-surface);
      cursor: pointer;
      transition: all var(--ds-transition-fast);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .account-item:hover {
      background: var(--bg-surface-hover);
      border-color: var(--border-l2);
    }
    .account-item.active-item {
      background: var(--brand-surface);
      border-color: var(--brand-primary);
    }
    .account-item-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .account-email {
      font-weight: 500;
      font-size: 13px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .account-item-bottom {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    /* Badges & Pills */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 500;
      line-height: 16px;
      padding: 1px 7px;
      border-radius: 10px;
    }
    .badge-primary { background: var(--brand-surface); color: var(--brand-primary); }
    .badge-success { background: var(--state-success-bg); color: var(--state-success); }
    .badge-warn { background: var(--state-warn-bg); color: var(--state-warn); }
    .badge-error { background: var(--state-error-bg); color: var(--state-error); }
    .badge-neutral { background: var(--bg-surface-elevated); color: var(--text-secondary); }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }

    /* Account Detail View */
    .detail-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      flex-wrap: wrap;
      padding-bottom: 14px;
      margin-bottom: 14px;
      border-bottom: 1px solid var(--border-l1);
    }
    .detail-meta h2 {
      font-size: 16px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .detail-meta p {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 4px;
    }
    .detail-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    /* Quota Section */
    .quota-table-wrap {
      overflow-x: auto;
      margin-top: 8px;
    }
    .quota-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .quota-table th, .quota-table td {
      padding: 8px 10px;
      text-align: left;
      border-bottom: 1px solid var(--border-l1);
    }
    .quota-table th {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .model-name {
      font-family: var(--ds-font-family-code);
      font-weight: 500;
      font-size: 12.5px;
      color: var(--text-primary);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .model-name:hover {
      color: var(--brand-primary);
      text-decoration: underline;
    }
    .progress-bar {
      background: var(--bg-surface-elevated);
      border-radius: 4px;
      height: 8px;
      width: 110px;
      overflow: hidden;
      display: inline-block;
      vertical-align: middle;
      margin-right: 8px;
    }
    .progress-fill {
      height: 100%;
      border-radius: 4px;
      transition: width var(--ds-transition-normal);
    }
    .reset-time {
      font-size: 12px;
      color: var(--text-tertiary);
      white-space: nowrap;
    }

    /* Collapsible diagnostics */
    details.diagnostics {
      margin-top: 14px;
      border: 1px solid var(--border-l1);
      border-radius: 8px;
      background: var(--bg-surface-elevated);
      overflow: hidden;
    }
    details.diagnostics summary {
      padding: 8px 12px;
      font-size: 12.5px;
      font-weight: 500;
      color: var(--text-secondary);
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    details.diagnostics summary:hover {
      color: var(--text-primary);
    }
    .diagnostics-body {
      padding: 12px;
      border-top: 1px solid var(--border-l1);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    pre.code-view {
      font-family: var(--ds-font-family-code);
      font-size: 12px;
      background: var(--bg-input);
      border: 1px solid var(--border-l1);
      border-radius: 6px;
      padding: 10px;
      overflow-x: auto;
      word-break: break-all;
      white-space: pre-wrap;
      color: var(--text-secondary);
    }

    /* Import Form */
    .import-section {
      margin-top: 4px;
    }
    .import-textarea {
      width: 100%;
      font-family: var(--ds-font-family-code);
      font-size: 12.5px;
      padding: 10px 12px;
      background: var(--bg-input);
      border: 1px solid var(--border-l2);
      border-radius: 8px;
      color: var(--text-primary);
      resize: vertical;
      min-height: 70px;
      outline: none;
      transition: border-color var(--ds-transition-fast);
      margin-bottom: 8px;
    }
    .import-textarea:focus {
      border-color: var(--brand-primary);
      box-shadow: 0 0 0 2px var(--brand-surface);
    }

    /* Toast Notification System */
    #toast-container {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: 380px;
      pointer-events: none;
    }
    .toast {
      background: var(--bg-surface);
      color: var(--text-primary);
      border: 1px solid var(--border-l2);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      box-shadow: var(--shadow-lg);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      pointer-events: auto;
      animation: toast-in 0.2s var(--ds-ease-in-out);
      transition: opacity 0.2s, transform 0.2s;
    }
    .toast-success { border-left: 4px solid var(--state-success); }
    .toast-error { border-left: 4px solid var(--state-error); }
    .toast-info { border-left: 4px solid var(--brand-primary); }
    @keyframes toast-in {
      from { transform: translateY(12px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header class="header">
      <div class="header-title-group">
        <h1>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--brand-primary)"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path></svg>
          <span id="txt-title">Antigravity Account Pool</span>
        </h1>
        <p id="txt-subtitle">Manage multi-account rotation, quota monitoring, and credentials.</p>
      </div>
      <div class="header-actions">
        <button id="btn-lang" class="btn btn-secondary btn-sm" title="Toggle Language">中文</button>
        <button id="btn-refresh" class="btn btn-secondary" title="Refresh accounts">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>
          <span id="txt-refresh">Refresh</span>
        </button>
        <button id="btn-login" class="btn btn-primary">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/></svg>
          <span id="txt-login">Login with Google</span>
        </button>
      </div>
    </header>

    <!-- Main Workspace -->
    <main class="main-grid">
      <!-- Master: Account List -->
      <section class="card">
        <div class="card-title">
          <span id="txt-accounts-list">Accounts</span>
          <span id="account-total-badge" class="badge badge-neutral">0</span>
        </div>
        <ul id="account-list" class="account-list">
          <li style="color:var(--text-tertiary);font-size:13px;padding:8px 0;" id="txt-loading">Loading accounts...</li>
        </ul>
      </section>

      <!-- Detail: Selected Account Details -->
      <section class="card" id="detail-card">
        <div id="detail-content">
          <p style="color:var(--text-tertiary);" id="txt-no-accounts-hint">Select or add an account to view details.</p>
        </div>
      </section>
    </main>

    <!-- Bottom: Import Section -->
    <section class="card import-section">
      <div class="card-title">
        <span id="txt-import-title">Import Credentials</span>
      </div>
      <p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:8px;" id="txt-import-desc">
        Paste an agy auth.json token document, or a credential blob (from dsh-agy login --blob). Paste multiple blobs, one per line, for a batch import:
      </p>
      <textarea id="input-import" class="import-textarea" placeholder='{"token":{"access_token":"...","refresh_token":"..."}} or dsh-agy-cred-v1.... (one blob per line for batch)'></textarea>
      <div style="display:flex;gap:8px;">
        <button id="btn-import-json" class="btn btn-secondary">
          <span id="txt-import-json">Import JSON</span>
        </button>
        <button id="btn-import-blob" class="btn btn-secondary">
          <span id="txt-import-blob">Import Blob</span>
        </button>
        <span style="flex:1"></span>
        <button id="btn-export-all" class="btn btn-secondary">
          <span id="txt-export-all">Export All</span>
        </button>
      </div>
    </section>
  </div>

  <div id="toast-container"></div>

  <script>
    const I18N = ${i18nJson};
    let currentLang = localStorage.getItem('agy_lang') || (navigator.language.startsWith('zh') ? 'zh' : 'en');
    let accountData = [];
    let selectedIndex = 0;
    let isBusy = false;

    function t(key) {
      const dict = I18N[currentLang] || I18N.en;
      return dict[key] || I18N.en[key] || key;
    }

    const $ = (id) => document.getElementById(id);

    function esc(s) {
      if (s == null) return '';
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function toast(text, type = 'info') {
      const container = $('toast-container');
      const el = document.createElement('div');
      el.className = 'toast toast-' + type;
      el.innerHTML = '<span>' + esc(text) + '</span><span style="cursor:pointer;opacity:0.6;font-weight:600;" onclick="this.parentElement.remove()">✕</span>';
      container.appendChild(el);
      setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(8px)';
        setTimeout(() => el.remove(), 200);
      }, 3500);
    }

    function copyToClipboard(text, msg) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => toast(msg || t('copied'), 'success')).catch(() => fallbackCopy(text, msg));
      } else {
        fallbackCopy(text, msg);
      }
    }

    function fallbackCopy(text, msg) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        toast(msg || t('copied'), 'success');
      } catch {
        toast('Failed to copy', 'error');
      }
      document.body.removeChild(ta);
    }

    function formatRelativeTime(dateStr) {
      if (!dateStr) return '';
      const target = new Date(dateStr).getTime();
      const diffMs = target - Date.now();
      if (diffMs <= 0) return '';
      const diffMin = Math.round(diffMs / 60000);
      if (diffMin < 60) return t('resetIn') + diffMin + 'm';
      const diffHours = (diffMs / 3600000).toFixed(1);
      if (diffHours < 24) return t('resetIn') + diffHours + 'h';
      return t('resetAt') + new Date(target).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function quotaColor(fraction) {
      if (fraction == null) return 'var(--text-dimmed)';
      return fraction > 0.7 ? 'var(--state-success)' : fraction >= 0.3 ? 'var(--state-warn)' : 'var(--state-error)';
    }

    function getWorstQuotaFraction(acc) {
      const models = (acc.quota && acc.quota.models) || [];
      let worst = 1;
      let hasQuota = false;
      for (const m of models) {
        if (m.remainingFraction != null) {
          worst = Math.min(worst, m.remainingFraction);
          hasQuota = true;
        }
      }
      return hasQuota ? worst : null;
    }

    function applyI18nLabels() {
      $('txt-title').textContent = t('title');
      $('txt-subtitle').textContent = t('subtitle');
      $('txt-refresh').textContent = t('refresh');
      $('txt-login').textContent = t('loginWithGoogle');
      $('btn-lang').textContent = t('switchLang');
      $('txt-accounts-list').textContent = t('accountsList');
      $('txt-import-title').textContent = t('importTitle');
      $('txt-import-desc').textContent = t('importDesc');
      $('txt-import-json').textContent = t('importJson');
      $('txt-import-blob').textContent = t('importBlobBtn');
      $('txt-export-all').textContent = t('exportAll');
      $('input-import').placeholder = t('importPlaceholder');
    }

    async function api(path, init) {
      const res = await fetch('/agy/api' + path, {
        headers: { 'content-type': 'application/json' },
        ...init
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
      return data;
    }

    function renderMasterList() {
      const listEl = $('account-list');
      $('account-total-badge').textContent = String(accountData.length);

      if (accountData.length === 0) {
        listEl.innerHTML = '<li style="color:var(--text-tertiary);font-size:13px;padding:12px 0;">' + esc(t('noAccounts')) + '</li>';
        return;
      }

      listEl.innerHTML = accountData.map((a, i) => {
        const isSelected = i === selectedIndex;
        const worstFrac = getWorstQuotaFraction(a);
        const dotColor = quotaColor(worstFrac);

        let stateBadge = '';
        if (a.state === 'disabled') {
          stateBadge = '<span class="badge badge-error">' + esc(t('stateDisabled')) + '</span>';
        } else if (a.state === 'verification-required') {
          stateBadge = '<span class="badge badge-warn">' + esc(t('stateVerificationRequired')) + '</span>';
        } else if (a.state === 'cooling') {
          stateBadge = '<span class="badge badge-warn">' + esc(t('stateCooling')) + '</span>';
        } else if (a.rateLimits && Object.values(a.rateLimits).some((t) => t > Date.now())) {
          stateBadge = '<span class="badge badge-warn">' + esc(t('stateRateLimited')) + '</span>';
        } else {
          stateBadge = '<span class="badge badge-success">' + esc(t('stateActive')) + '</span>';
        }

        const activeMark = a.active ? '<span class="badge badge-primary">★ ' + esc(t('activeBadge')) + '</span>' : '';

        return '<li class="account-item ' + (isSelected ? 'active-item' : '') + '" onclick="selectAccount(' + i + ')">' +
          '<div class="account-item-top">' +
            '<span class="account-email" title="' + esc(a.email || '(no email)') + '">' + esc(a.email || '(no email)') + '</span>' +
            '<span class="dot" style="background:' + dotColor + '" title="Quota Health"></span>' +
          '</div>' +
          '<div class="account-item-bottom">' + activeMark + stateBadge + '</div>' +
        '</li>';
      }).join('');
    }

    function renderDetailView() {
      const container = $('detail-content');
      if (accountData.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:32px 12px;color:var(--text-tertiary);">' +
          '<p style="font-size:15px;font-weight:500;margin-bottom:4px;">' + esc(t('noAccounts')) + '</p>' +
          '<p style="font-size:13px;">' + esc(t('noAccountsHint')) + '</p>' +
        '</div>';
        return;
      }

      const a = accountData[selectedIndex] || accountData[0];
      const isVerificationRequired = a.state === 'verification-required';
      const isCooling = a.state === 'cooling' && a.cooldownUntil;
      const coolInfo = isCooling ? ' (' + formatRelativeTime(a.cooldownUntil) + ')' : '';

      const models = (a.quota && a.quota.models) || [];
      const quotaRows = models.map((m) => {
        const pct = m.remainingFraction != null ? Math.round(m.remainingFraction * 100) : null;
        const color = quotaColor(m.remainingFraction);
        const resetText = m.resetTime ? formatRelativeTime(m.resetTime) : '';
        const exactReset = m.resetTime ? new Date(m.resetTime).toLocaleString() : '';

        return '<tr>' +
          '<td><span class="model-name" onclick="copyToClipboard(\\'' + esc(m.id) + '\\')" title="Click to copy ID">' + esc(m.id) + '</span></td>' +
          '<td>' +
            (pct != null
              ? '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%;background:' + color + '"></div></div><span style="font-weight:500;font-size:12px;">' + pct + '%</span>'
              : '<span style="color:var(--text-tertiary);font-size:12px;">' + esc(t('noQuotaReported')) + '</span>') +
          '</td>' +
          '<td><span class="reset-time" title="' + esc(exactReset) + '">' + esc(resetText) + '</span></td>' +
          '<td style="text-align:right;">' +
            '<button class="btn btn-secondary btn-sm" data-test-model="' + esc(m.id) + '">' + esc(t('testModel')) + '</button>' +
          '</td>' +
        '</tr>';
      }).join('');

      container.innerHTML = 
        '<div class="detail-head">' +
          '<div class="detail-meta">' +
            '<h2>' + esc(a.email || '(no email)') + (a.active ? ' <span class="badge badge-primary">★ ' + esc(t('activeBadge')) + '</span>' : '') + '</h2>' +
            '<p>' + esc(t('project')) + ': <code>' + esc(a.projectId || t('defaultProject')) + '</code>' + esc(coolInfo) + '</p>' +
          '</div>' +
          '<div class="detail-actions">' +
            (isVerificationRequired ? '<button class="btn btn-cta btn-sm" id="btn-action-verify">⚡ ' + esc(t('verifyCta')) + '</button>' : '') +
            (!a.active ? '<button class="btn btn-secondary btn-sm" id="btn-action-activate">' + esc(t('activate')) + '</button>' : '') +
            (!isVerificationRequired ? '<button class="btn btn-secondary btn-sm" id="btn-action-verify">' + esc(t('verify')) + '</button>' : '') +
            '<button class="btn btn-secondary btn-sm" id="btn-action-export">' + esc(t('exportBlob')) + '</button>' +
            '<button class="btn btn-secondary btn-sm" id="btn-action-fp">' + esc(t('fingerprint')) + '</button>' +
            '<button class="btn btn-danger btn-sm" id="btn-action-delete">' + esc(t('deleteAccount')) + '</button>' +
          '</div>' +
          '</div>' +

        '<div style="margin-top:14px;padding:10px 12px;border:1px solid var(--border-l1);border-radius:8px;background:var(--bg-surface-elevated);display:flex;flex-wrap:wrap;gap:8px;align-items:center;">' +
          '<span style="font-size:13px;font-weight:500;white-space:nowrap;">Proxy:</span>' +
          '<input id="proxy-input-' + selectedIndex + '" placeholder="socks5://user:pass@host:1080" style="flex:1;min-width:220px;font-family:var(--ds-font-family-code);font-size:12.5px;padding:6px 10px;background:var(--bg-input);border:1px solid var(--border-l2);border-radius:6px;color:var(--text-primary);outline:none;">' +
          '<button class="btn btn-primary btn-sm" id="btn-proxy-save">Save</button>' +
          '<button class="btn btn-secondary btn-sm" id="btn-proxy-clear">Clear</button>' +
          '<button class="btn btn-secondary btn-sm" id="btn-proxy-test">Test</button>' +
          '<span id="proxy-status" style="font-size:12px;color:var(--text-secondary);">' + ((a.proxy || a.proxyMasked) ? 'Current: ' + esc(a.proxy || a.proxyMasked) : 'No proxy (using env)') + '</span>' +
        '</div>' +

        '<div style="margin-top:16px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
            '<h3 style="font-size:13.5px;font-weight:600;">' + esc(t('quotaTitle')) + ' (' + models.length + ')</h3>' +
            (models.length > 0 ? '<button class="btn btn-secondary btn-sm" id="btn-action-test-all">⚡ ' + esc(t('testAll')) + '</button>' : '') +
          '</div>' +
          '<div class="quota-table-wrap">' +
            '<table class="quota-table">' +
              '<thead><tr><th>Model</th><th>Remaining</th><th>Reset</th><th style="text-align:right;">Action</th></tr></thead>' +
              '<tbody>' + (quotaRows || '<tr><td colspan="4" style="color:var(--text-tertiary);text-align:center;padding:16px 0;">' + esc(t('quotaUnavailable')) + '</td></tr>') + '</tbody>' +
            '</table>' +
          '</div>' +
        '</div>' +

        '<details class="diagnostics" id="diagnostics-panel">' +
          '<summary><span>' + esc(t('fingerprintTitle')) + ' & Output</span><span>▼</span></summary>' +
          '<div class="diagnostics-body">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
              '<span style="font-size:12px;color:var(--text-secondary);">' + esc(t('fingerprintHistory')) + ': ' + (a.fingerprintHistory || 0) + '</span>' +
              '<button class="btn btn-secondary btn-sm" id="btn-action-regen-fp">' + esc(t('regenerateFp')) + '</button>' +
            '</div>' +
            '<pre class="code-view" id="diagnostics-output">' + (a.fingerprint ? esc(JSON.stringify(a.fingerprint, null, 2)) : 'No diagnostics generated yet.') + '</pre>' +
          '</div>' +
        '</details>';

      bindDetailActions(selectedIndex);
    }

    function selectAccount(index) {
      selectedIndex = index;
      renderMasterList();
      renderDetailView();
    }

    function bindDetailActions(index) {
      const btnActivate = $('btn-action-activate');
      if (btnActivate) btnActivate.onclick = async () => {
        try {
          await api('/activate', { method: 'POST', body: JSON.stringify({ index }) });
          toast(t('activeBadge') + ' -> #' + (index + 1), 'success');
          render();
        } catch (e) { toast(String(e), 'error'); }
      };

      const btnVerify = $('btn-action-verify');
      if (btnVerify) btnVerify.onclick = async () => {
        btnVerify.disabled = true;
        try {
          await api('/verify', { method: 'POST', body: JSON.stringify({ index }) });
          toast('Account #' + (index + 1) + ' verified successfully', 'success');
          render();
        } catch (e) { toast(String(e), 'error'); }
        finally { btnVerify.disabled = false; }
      };

      const btnDelete = $('btn-action-delete');
      if (btnDelete) btnDelete.onclick = async () => {
        if (!confirm(t('confirmDelete'))) return;
        try {
          await api('/delete', { method: 'POST', body: JSON.stringify({ index }) });
          toast('Account deleted', 'success');
          if (selectedIndex >= accountData.length - 1) selectedIndex = Math.max(0, accountData.length - 2);
          render();
        } catch (e) { toast(String(e), 'error'); }
      };

      const btnExport = $('btn-action-export');
      if (btnExport) btnExport.onclick = async () => {
        try {
          const r = await api('/export', { method: 'POST', body: JSON.stringify({ index }) });
          copyToClipboard(r.blob, t('copyBlobMsg'));
          $('diagnostics-panel').open = true;
          $('diagnostics-output').textContent = r.blob;
        } catch (e) { toast(String(e), 'error'); }
      };

      const btnFp = $('btn-action-fp');
      if (btnFp) btnFp.onclick = async () => {
        try {
          const r = await api('/fingerprint', { method: 'POST', body: JSON.stringify({ index }) });
          $('diagnostics-panel').open = true;
          $('diagnostics-output').textContent = JSON.stringify(r.fingerprint, null, 2);
          toast(t('copyFpMsg'), 'info');
        } catch (e) { toast(String(e), 'error'); }
      };

      const btnRegenFp = $('btn-action-regen-fp');
      if (btnRegenFp) btnRegenFp.onclick = async () => {
        if (!confirm(t('confirmRegenerateFp'))) return;
        try {
          const r = await api('/fingerprint', { method: 'POST', body: JSON.stringify({ index, action: 'regenerate' }) });
          $('diagnostics-panel').open = true;
          $('diagnostics-output').textContent = JSON.stringify(r.fingerprint, null, 2);
          toast('Fingerprint regenerated', 'success');
          render();
        } catch (e) { toast(String(e), 'error'); }
      };

      const btnTestAll = $('btn-action-test-all');
      if (btnTestAll) btnTestAll.onclick = async () => {
        if (!confirm(t('confirmTestAll'))) return;
        btnTestAll.disabled = true;
        const a = accountData[index];
        const models = ((a.quota && a.quota.models) || []).map((m) => m.id);
        toast(t('testing') + ' (' + models.length + ')', 'info');
        let okCount = 0;
        let failCount = 0;
        const lines = [];

        for (const model of models) {
          try {
            const r = await api('/test', { method: 'POST', body: JSON.stringify({ model, index }) });
            if (r.ok) {
              okCount++;
              lines.push('OK   ' + model);
            } else {
              failCount++;
              lines.push('FAIL ' + model + ' - ' + r.error);
            }
          } catch (err) {
            failCount++;
            lines.push('ERR  ' + model + ' - ' + String(err));
          }
        }
        $('diagnostics-panel').open = true;
        $('diagnostics-output').textContent = lines.join('\\n');
        toast(t('modelsTestedSummary').replace('{total}', String(models.length)).replace('{ok}', String(okCount)).replace('{failed}', String(failCount)), failCount === 0 ? 'success' : 'warn');
        btnTestAll.disabled = false;
      };

      // Proxy actions
      const btnProxySave = $('btn-proxy-save');
      if (btnProxySave) btnProxySave.onclick = async () => {
        const input = $('proxy-input-' + index);
        const proxy = input ? input.value.trim() : '';
        btnProxySave.disabled = true;
        try {
          const r = await api('/proxy', { method: 'POST', body: JSON.stringify({ index, proxy }) });
          const masked = r.proxy || r.proxyMasked || '';
          const statusEl = $('proxy-status');
          if (statusEl) statusEl.textContent = masked ? 'Current: ' + masked : 'No proxy (using env)';
          toast(masked ? 'Proxy saved: ' + masked : 'Proxy cleared (using env)', 'success');
          render();
        } catch (e) { toast(String(e), 'error'); }
        finally { btnProxySave.disabled = false; }
      };
      const btnProxyClear = $('btn-proxy-clear');
      if (btnProxyClear) btnProxyClear.onclick = async () => {
        btnProxyClear.disabled = true;
        try {
          await api('/proxy', { method: 'POST', body: JSON.stringify({ index, proxy: '' }) });
          const statusEl = $('proxy-status');
          if (statusEl) statusEl.textContent = 'No proxy (using env)';
          const input = $('proxy-input-' + index);
          if (input) input.value = '';
          toast('Proxy cleared (using env)', 'success');
          render();
        } catch (e) { toast(String(e), 'error'); }
        finally { btnProxyClear.disabled = false; }
      };
      const btnProxyTest = $('btn-proxy-test');
      if (btnProxyTest) btnProxyTest.onclick = async () => {
        const input = $('proxy-input-' + index);
        const val = input ? input.value.trim() : '';
        const body = val ? { index, proxy: val } : { index };
        btnProxyTest.disabled = true;
        btnProxyTest.textContent = '...';
        try {
          const r = await api('/proxy/test', { method: 'POST', body: JSON.stringify(body) });
          const masked = r.masked ? esc(r.masked) : '';
          const statusEl = $('proxy-status');
          if (r.ok) {
            toast('Proxy reachable: ' + (r.masked || ''), 'success');
            if (statusEl) statusEl.textContent = 'Reachable: ' + (r.masked || '');
          } else {
            toast('Proxy unreachable: ' + (r.masked || '') + (r.error ? ' - ' + r.error : ''), 'error');
            if (statusEl) statusEl.textContent = 'Unreachable: ' + (r.masked || '') + (r.error ? ' (' + r.error + ')' : '');
          }
        } catch (e) { toast(String(e), 'error'); }
        finally { btnProxyTest.disabled = false; btnProxyTest.textContent = 'Test'; }
      };

      // Single model tests
      document.querySelectorAll('[data-test-model]').forEach((btn) => {
        btn.onclick = async () => {
          const model = btn.getAttribute('data-test-model');
          btn.disabled = true;
          btn.textContent = '...';
          try {
            const r = await api('/test', { method: 'POST', body: JSON.stringify({ model, index: selectedIndex }) });
            if (r.ok) {
              toast('OK: ' + model, 'success');
            } else {
              toast('FAIL: ' + model + ' - ' + r.error, 'error');
            }
          } catch (err) {
            toast('ERR: ' + model + ' - ' + String(err), 'error');
          } finally {
            btn.disabled = false;
            btn.textContent = t('testModel');
          }
        };
      });
    }

    async function render() {
      if (isBusy) return;
      isBusy = true;
      try {
        const data = await api('/accounts');
        accountData = data.accounts || [];
        if (selectedIndex >= accountData.length) selectedIndex = Math.max(0, accountData.length - 1);
        renderMasterList();
        renderDetailView();
      } catch (e) {
        toast(String(e), 'error');
      } finally {
        isBusy = false;
      }
    }

    // Event Handlers
    $('btn-refresh').onclick = render;

    $('btn-lang').onclick = () => {
      currentLang = currentLang === 'zh' ? 'en' : 'zh';
      localStorage.setItem('agy_lang', currentLang);
      applyI18nLabels();
      renderMasterList();
      renderDetailView();
    };

    $('btn-login').onclick = async () => {
      try {
        const { url } = await api('/auth-url', { method: 'POST' });
        window.open(url, '_blank');
        toast(t('windowClosing'), 'info');
      } catch (e) { toast(String(e), 'error'); }
    };

    const importLines = () => $('input-import').value.split('\\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const doImport = async (kind) => {
      const sources = importLines();
      if (sources.length === 0) return;
      try {
        const r = await api('/import', { method: 'POST', body: JSON.stringify({ kind, sources }) });
        if (r.errors && r.errors.length > 0) toast(r.errors[0], 'error');
        toast(t('importBatchResult').replace('{imported}', r.imported).replace('{replaced}', r.replaced), 'success');
        $('input-import').value = '';
        render();
      } catch (e) { toast(String(e), 'error'); }
    };

    $('btn-import-json').onclick = () => doImport('json');
    $('btn-import-blob').onclick = () => doImport('blob');

    const btnExportAll = $('btn-export-all');
    if (btnExportAll) btnExportAll.onclick = async () => {
      try {
        const r = await api('/export-all', { method: 'POST' });
        if (!r.blobs || r.blobs.length === 0) { toast('No accounts to export', 'info'); return; }
        const text = r.blobs.map((b) => b.blob).join('\\n');
        copyToClipboard(text, t('copyAllMsg'));
        $('diagnostics-panel').open = true;
        $('diagnostics-output').textContent = text;
      } catch (e) { toast(String(e), 'error'); }
    };

    // Auto-refresh when tab receives focus or receives postMessage from login popup
    window.addEventListener('focus', render);
    window.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'agy_login_success') {
        toast(t('loginSuccessTitle'), 'success');
        render();
      }
    });

    // Init
    applyI18nLabels();
    render();
  </script>
</body>
</html>`
}

export function renderCallbackHtml(options: { ok: boolean; error?: string; email?: string | null; baseUrl: string }): string {
  const { ok, error, email, baseUrl } = options
  const i18nJson = JSON.stringify(I18N_DICT)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Antigravity Sign-in</title>
  <style>
    :root {
      color-scheme: light dark;
      --dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
      --bg-page: #0f1115;
      --bg-surface: #171a21;
      --border-l2: rgba(255, 255, 255, 0.12);
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --brand-primary: #5686fe;
      --state-success: #34d399;
      --state-error: #f87171;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg-page: #f8fafc;
        --bg-surface: #ffffff;
        --border-l2: rgba(0, 0, 0, 0.12);
        --text-primary: #0f172a;
        --text-secondary: #475569;
        --brand-primary: #4176e6;
        --state-success: #22c55e;
        --state-error: #ef4444;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--dsw-font-family);
      background-color: var(--bg-page);
      color: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 16px;
    }
    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-l2);
      border-radius: 12px;
      padding: 24px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
    }
    .icon-wrap {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px;
      font-size: 24px;
    }
    .icon-success { background: rgba(52, 211, 153, 0.15); color: var(--state-success); }
    .icon-error { background: rgba(248, 113, 113, 0.15); color: var(--state-error); }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    p { font-size: 13.5px; color: var(--text-secondary); margin-bottom: 16px; line-height: 1.5; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      height: 34px;
      padding: 0 16px;
      border-radius: 17px;
      border: 1px solid var(--border-l2);
      background: transparent;
      color: var(--text-primary);
      cursor: pointer;
      text-decoration: none;
    }
    .btn:hover { background: rgba(128, 128, 128, 0.1); }
    .btn-primary { background: var(--brand-primary); color: #ffffff; border-color: transparent; }
  </style>
</head>
<body>
  <div class="card">
    ${ok ? `
      <div class="icon-wrap icon-success">✓</div>
      <h1 id="title">Sign-in Successful</h1>
      <p id="desc">Your Antigravity account ${email ? '<strong>' + email + '</strong> ' : ''}has been authorized and saved.</p>
      <p style="font-size:12px;opacity:0.8;" id="closing">This window will close automatically...</p>
      <button class="btn" onclick="window.close()">Close Window</button>
    ` : `
      <div class="icon-wrap icon-error">✕</div>
      <h1 id="title">Sign-in Failed</h1>
      <p id="desc">Error details: ${error || 'Unknown error'}</p>
      <a class="btn btn-primary" href="${baseUrl}/agy">Return to Dashboard</a>
    `}
  </div>
  <script>
    const I18N = ${i18nJson};
    const lang = localStorage.getItem('agy_lang') || (navigator.language.startsWith('zh') ? 'zh' : 'en');
    const dict = I18N[lang] || I18N.en;

    if (${ok ? 'true' : 'false'}) {
      document.getElementById('title').textContent = dict.loginSuccessTitle;
      document.getElementById('desc').innerHTML = dict.loginSuccessDesc + (${JSON.stringify(email ? ' (' + email + ')' : '')});
      document.getElementById('closing').textContent = dict.windowClosing;
      
      // Notify parent window & close
      try {
        if (window.opener) {
          window.opener.postMessage({ type: 'agy_login_success' }, '*');
        }
      } catch (e) {}
      setTimeout(() => {
        window.close();
      }, 1800);
    } else {
      document.getElementById('title').textContent = dict.loginFailedTitle;
    }
  </script>
</body>
</html>`
}
