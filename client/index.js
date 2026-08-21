window.__ModuleLoader__.load({
  id: 'dsh-agent-alliance',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var react = require('react');
    var reactDomClient = require('react-dom/client');
    var h = react.createElement;

    // ---------- 样式（<style> 注入，aaa- 前缀隔离） ----------
    var CSS = [
      '[data-dsh-aa-entry]{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;margin:2px 0;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#9a9aa0);cursor:pointer;font-size:13px;text-align:left}',
      '[data-dsh-aa-entry]:hover{background:var(--dsw-alias-fill-secondary,rgba(128,128,128,.12))}',
      '.aaa-overlay{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}',
      '.aaa-panel{width:min(860px,92vw);max-height:86vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-primary,#1c1c1e);color:var(--dsw-alias-label-primary,#eee);border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.5);overflow:hidden}',
      '.aaa-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(128,128,128,.2)}',
      '.aaa-title{font-size:14px;font-weight:600}',
      '.aaa-close{border:none;background:transparent;color:inherit;font-size:16px;cursor:pointer;padding:4px 8px;border-radius:6px}',
      '.aaa-tabs{display:flex;gap:4px;padding:8px 12px 0}',
      '.aaa-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#999);padding:6px 12px;border-radius:8px 8px 0 0;cursor:pointer;font-size:13px}',
      '.aaa-tab[data-active="1"]{background:var(--dsw-alias-fill-secondary,rgba(128,128,128,.15));color:var(--dsw-alias-label-primary,#eee)}',
      '.aaa-body{flex:1;overflow:auto;padding:14px 16px;font-size:13px;line-height:1.55}',
      '.aaa-card{border:1px solid rgba(128,128,128,.22);border-radius:10px;padding:10px 12px;margin-bottom:10px}',
      '.aaa-ok{color:#4cc38a}.aaa-bad{color:#f0616d}.aaa-dim{color:var(--dsw-alias-label-tertiary,#888)}',
      '.aaa-row{display:flex;align-items:center;gap:8px;padding:6px 4px;border-radius:6px;cursor:pointer}',
      '.aaa-row:hover{background:var(--dsw-alias-fill-secondary,rgba(128,128,128,.1))}',
      '.aaa-btn{border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;border-radius:7px;padding:4px 10px;cursor:pointer;font-size:12px}',
      '.aaa-btn:hover{background:var(--dsw-alias-fill-secondary,rgba(128,128,128,.12))}',
      '.aaa-input,.aaa-select,.aaa-textarea{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-secondary,#2a2a2c);color:inherit;border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit}',
      '.aaa-textarea{min-height:90px;resize:vertical}',
      '.aaa-pre{white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-secondary,#26262a);border-radius:8px;padding:10px;max-height:300px;overflow:auto}',
      '.aaa-tag{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid rgba(128,128,128,.35)}'
    ].join('\n');

    function ensureStyle() {
      if (document.getElementById('dsh-aa-style')) return;
      var el = document.createElement('style');
      el.id = 'dsh-aa-style';
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    // ---------- API ----------
    function api(path, opts) {
      return fetch('/__agent-alliance' + path, opts).then(function (r) {
        return r.json().then(function (j) { return { status: r.status, json: j }; });
      });
    }
    function getState() { return api('/state'); }
    function getSessions(provider) {
      return api('/sessions?limit=30' + (provider ? '&provider=' + encodeURIComponent(provider) : ''));
    }
    function getContent(provider, id) {
      return api('/session-content?provider=' + encodeURIComponent(provider) + '&id=' + encodeURIComponent(id));
    }
    function postImport(provider, id) {
      return api('/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: provider, sessionId: id }) });
    }
    function postDispatch(payload) {
      return api('/dispatch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    }

    // ---------- 侧边栏入口（DOM 注入 + 自愈，task-board 先例） ----------
    var ENTRY_ATTR = 'data-dsh-aa-entry';
    var ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="5" r="2.2"/><circle cx="11" cy="5" r="2.2"/><path d="M2.5 13c.6-2.2 2.4-3.2 4.6-3.2S11.4 10.8 12 13"/><path d="M9.5 11.5l1.5 1.5 2.5-3"/></svg>';
    function sidebarRoot() {
      var column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
      if (!column) return undefined;
      var logoOwner = column.querySelector('[class*="logoRow"]');
      return (logoOwner && logoOwner.parentElement) || column.firstElementChild || undefined;
    }
    function newSessionButton(root) {
      var nested = root.querySelector('button[class*="newSession"]');
      if (nested) return nested;
      for (var i = 0; i < root.children.length; i++) {
        if (root.children[i].tagName === 'BUTTON') return root.children[i];
      }
      return undefined;
    }
    function mountSidebarEntry(onToggle) {
      var entry = null;
      function build() {
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute(ENTRY_ATTR, '');
        b.innerHTML = '<span>' + ICON + '</span><span>Agent 协同</span>';
        b.addEventListener('click', onToggle);
        return b;
      }
      function place() {
        var rootEl = sidebarRoot();
        if (!rootEl) return false;
        if (entry && entry.isConnected) return true;
        if (!entry) entry = build();
        var anchor = newSessionButton(rootEl);
        if (anchor && anchor.parentElement === rootEl) anchor.insertAdjacentElement('afterend', entry);
        else rootEl.appendChild(entry);
        return true;
      }
      place();
      var observer = new MutationObserver(function () { place(); });
      var rootEl = sidebarRoot();
      if (rootEl) observer.observe(rootEl, { childList: true });
      else observer.observe(document.body, { childList: true, subtree: true });
      return function () { observer.disconnect(); if (entry) entry.remove(); entry = null; };
    }

    // ---------- 面板组件 ----------
    function StateTab() {
      var s = react.useState({ providers: [], err: null });
      var st = s[0], set = s[1];
      react.useEffect(function () {
        getState().then(function (r) { set({ providers: r.json.providers || [], err: null }); },
          function () { set({ providers: [], err: '无法读取状态' }); });
      }, []);
      return h('div', null,
        st.err ? h('div', { className: 'aaa-bad' }, st.err) : null,
        st.providers.map(function (p) {
          return h('div', { key: p.id, className: 'aaa-card' },
            h('div', null, h('b', null, p.label || p.id), ' ',
              p.available ? h('span', { className: 'aaa-ok' }, '● 在线' + (p.version ? ' ' + p.version : ''))
                          : h('span', { className: 'aaa-bad' }, '● 离线')),
            p.detail ? h('div', { className: 'aaa-dim' }, String(p.detail).slice(0, 140)) : null);
        }));
    }

    function SessionsTab() {
      var s = react.useState({ providers: [], sessions: [], filter: '', content: null, busy: false, msg: '' });
      var st = s[0], set = s[1];
      var load = function (filter) {
        set(function (cur) { return Object.assign({}, cur, { busy: true }); });
        getSessions(filter).then(function (r) {
          set(function (cur) { return Object.assign({}, cur, { sessions: r.json.sessions || [], busy: false }); });
        }, function () { set(function (cur) { return Object.assign({}, cur, { busy: false }); }); });
      };
      react.useEffect(function () {
        getState().then(function (r) {
          set(function (cur) { return Object.assign({}, cur, { providers: (r.json.providers || []).filter(function (p) { return p.available; }) }); });
        });
        load('');
      }, []);
      var openContent = function (provider, id) {
        set(function (cur) { return Object.assign({}, cur, { content: { loading: true } }); });
        getContent(provider, id).then(function (r) {
          set(function (cur) { return Object.assign({}, cur, { content: { data: r.status === 200 ? r.json : null, error: r.status !== 200 ? r.json.error : null } }); });
        });
      };
      var doImport = function (provider, id) {
        set(function (cur) { return Object.assign({}, cur, { msg: '导入中…' }); });
        postImport(provider, id).then(function (r) {
          var j = r.json;
          var m = j.status === 'imported' ? ('✅ 已导入为 DSH 会话 ' + j.dshSessionId)
            : j.status === 'already-imported' ? ('已导入过：' + j.dshSessionId)
            : j.status === 'skipped' ? ('跳过：' + (j.reason || ''))
            : ('失败：' + (j.error || ''));
          set(function (cur) { return Object.assign({}, cur, { msg: m }); });
          load(st.filter);
        }, function () { set(function (cur) { return Object.assign({}, cur, { msg: '导入请求失败' }); }); });
      };
      return h('div', null,
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' } },
          h('button', { className: 'aaa-btn', onClick: function () { set(function (c) { return Object.assign({}, c, { filter: '' }); }); load(''); } }, '全部'),
          st.providers.map(function (p) {
            return h('button', { key: p.id, className: 'aaa-btn', onClick: function () { set(function (c) { return Object.assign({}, c, { filter: p.id }); }); load(p.id); } }, p.id);
          }),
          st.busy ? h('span', { className: 'aaa-dim' }, '加载中…') : null),
        st.msg ? h('div', { style: { margin: '6px 0' } }, st.msg) : null,
        st.sessions.slice(0, 40).map(function (x) {
          return h('div', { key: x.provider + '/' + x.id, className: 'aaa-row' },
            h('span', { className: 'aaa-tag' }, x.provider),
            h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: x.id },
              (x.title || '(无标题)') + (x.cwd ? '　@' + x.cwd : '')),
            x.imported ? h('span', { className: 'aaa-dim' }, '已导入') : null,
            h('button', { className: 'aaa-btn', onClick: function () { openContent(x.provider, x.id); } }, '查看'),
            h('button', { className: 'aaa-btn', disabled: !!x.imported, onClick: function () { doImport(x.provider, x.id); } }, x.imported ? '已导入' : '导入'));
        }),
        !st.sessions.length ? h('div', { className: 'aaa-dim' }, '（无会话）') : null,
        st.content ? h('div', { className: 'aaa-card', style: { marginTop: '10px' } },
          h('div', null, h('b', null, '内容预览'), ' ',
            h('button', { className: 'aaa-btn', onClick: function () { set(function (c) { return Object.assign({}, c, { content: null }); }); } }, '收起')),
          st.content.error ? h('div', { className: 'aaa-bad' }, st.content.error)
            : st.content.loading ? h('div', { className: 'aaa-dim' }, '加载中…')
            : h('pre', { className: 'aaa-pre' },
                ((st.content.data && st.content.data.messages) || []).map(function (m) { return '[' + m.role + '] ' + m.text; }).join('\n\n')))
          : null);
    }

    function DispatchTab() {
      var s = react.useState({ provider: 'claude', prompt: '', result: null, busy: false });
      var st = s[0], set = s[1];
      var upd = function (patch) { set(function (cur) { return Object.assign({}, cur, patch); }); };
      var run = function () {
        if (!st.prompt.trim()) return;
        upd({ busy: true, result: null });
        postDispatch({ provider: st.provider, prompt: st.prompt }).then(function (r) {
          upd({ busy: false, result: r.status === 200
            ? ('[' + r.json.provider + (r.json.externalSessionId ? ' 会话 ' + r.json.externalSessionId : '') + ']\n' + r.json.text)
            : ('失败：' + ((r.json && r.json.error) || r.status)) });
        }, function () { upd({ busy: false, result: '请求失败' }); });
      };
      return h('div', null,
        h('div', { style: { display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' } },
          h('select', { className: 'aaa-select', style: { width: '160px' }, value: st.provider, onChange: function (e) { upd({ provider: e.target.value }); } },
            ['claude', 'codex', 'opencode'].map(function (p) { return h('option', { key: p, value: p }, p); })),
          h('span', { className: 'aaa-dim' }, '⚠ 真实消耗该 agent 的 API 额度')),
        h('textarea', { className: 'aaa-textarea', placeholder: '任务描述…', value: st.prompt, onChange: function (e) { upd({ prompt: e.target.value }); } }),
        h('div', { style: { marginTop: '8px' } },
          h('button', { className: 'aaa-btn', disabled: st.busy, onClick: run }, st.busy ? '执行中…' : '派发')),
        st.result ? h('pre', { className: 'aaa-pre', style: { marginTop: '10px' } }, st.result) : null);
    }

    function Panel(props) {
      var ts = react.useState('state');
      var tab = ts[0], setTab = ts[1];
      if (!props.open) return null;
      var body = tab === 'state' ? h(StateTab) : tab === 'sessions' ? h(SessionsTab) : h(DispatchTab);
      return h('div', { className: 'aaa-overlay', onClick: props.onClose },
        h('div', { className: 'aaa-panel', onClick: function (e) { e.stopPropagation(); } },
          h('div', { className: 'aaa-head' },
            h('span', { className: 'aaa-title' }, 'Agent 协同'),
            h('button', { className: 'aaa-close', onClick: props.onClose }, '✕')),
          h('div', { className: 'aaa-tabs' },
            ['state', 'sessions', 'dispatch'].map(function (t) {
              return h('button', { key: t, className: 'aaa-tab', 'data-active': tab === t ? '1' : '0', onClick: function () { setTab(t); } },
                t === 'state' ? '状态' : t === 'sessions' ? '外部会话' : '派发任务');
            })),
          h('div', { className: 'aaa-body' }, body)));
    }

    // ---------- 插件对象 ----------
    var inject = [];

    function apply(ctx) {
      try {
        ctx.effect(function () {
          ensureStyle();
          var container = document.createElement('div');
          container.setAttribute('data-dsh-agent-alliance-root', '');
          document.body.appendChild(container);
          var root = reactDomClient.createRoot(container);
          var open = false;
          var renderPanel = function () { root.render(h(Panel, { open: open, onClose: function () { open = false; renderPanel(); } })); };
          var disposeEntry = mountSidebarEntry(function () { open = !open; renderPanel(); });
          renderPanel();
          return function () {
            disposeEntry();
            try { root.unmount(); } catch (e) { /* already gone */ }
            container.remove();
          };
        }, 'agent-alliance: ui');
      } catch (err) {
        console.error('[agent-alliance] client init failed:', err && err.message || err);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
