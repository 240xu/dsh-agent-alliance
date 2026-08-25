window.__ModuleLoader__.load({
  id: 'dsh-agent-alliance',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var react = require('react');
    var reactDomClient = require('react-dom/client');
    var h = react.createElement;

    var lastViewed = null;

    // ---------- i18n（跟随客户端语言；字典在 apply 里经 locale 服务注册） ----------
    var DICTS = {
      zh: {
        'entry.label': 'Agent 协同',
        'panel.title': 'Agent 协同',
        'tab.state': '状态', 'tab.sessions': '外部会话', 'tab.dispatch': '派发任务', 'tab.roundtable': '圆桌',
        'sess.all': '全部', 'sess.view': '查看', 'sess.import': '导入', 'sess.imported': '已导入',
        'sess.none': '（无会话）', 'sess.loading': '加载中…', 'sess.preview': '内容预览', 'sess.collapse': '收起',
        'disp.run': '派发', 'disp.running': '执行中…', 'disp.ph': '任务描述…',
        'rt.launch': '发起圆桌', 'rt.running': '圆桌进行中…', 'rt.ph': '圆桌问题…',
        'state.online': '● 在线', 'state.offline': '● 离线', 'common.close': '✕',
        'mode.single': '单发', 'mode.bc': '广播对比', 'bc.need': '广播模式请先在下方勾选至少一个 agent', 'bc.copy': '复制', 'disp.target': '目标',
        'pick.title': '参与协同的 Agent', 'pick.none': '（无可用 agent）', 'rt.sel': '参与方',
        'tab.tasks': '任务', 'task.none': '（暂无后台任务）', 'task.output': '输出', 'task.kill': '取消', 'task.done': '已完成'
      },
      en: {
        'entry.label': 'Agent Alliance',
        'panel.title': 'Agent Alliance',
        'tab.state': 'State', 'tab.sessions': 'Sessions', 'tab.dispatch': 'Dispatch', 'tab.roundtable': 'Roundtable',
        'sess.all': 'All', 'sess.view': 'View', 'sess.import': 'Import', 'sess.imported': 'Imported',
        'sess.none': '(no sessions)', 'sess.loading': 'Loading…', 'sess.preview': 'Preview', 'sess.collapse': 'Collapse',
        'disp.run': 'Dispatch', 'disp.running': 'Running…', 'disp.ph': 'Task description…',
        'rt.launch': 'Start roundtable', 'rt.running': 'Roundtable running…', 'rt.ph': 'Roundtable question…',
        'state.online': '● online', 'state.offline': '● offline', 'common.close': '✕',
        'tab.tasks': 'Tasks', 'task.none': '(no background tasks)', 'task.output': 'Output', 'task.kill': 'Kill', 'task.done': 'done'
      }
    };
    var T = function (k) { return (DICTS.zh[k] !== undefined ? DICTS.zh : DICTS.en)[k] || k };

    // ---------- 样式（<style> 注入，aaa- 前缀隔离） ----------
    var CSS = [
      '[data-dsh-aa-entry]{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;margin:2px 0;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;text-align:left}',
      '[data-dsh-aa-entry]:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}',
      '.aaa-overlay{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center}',
      '.aaa-panel{width:min(860px,92vw);max-height:86vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 18px 60px rgba(0,0,0,.35));overflow:hidden}',
      '.aaa-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.aaa-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.aaa-close{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px;cursor:pointer;padding:4px 8px;border-radius:6px}',
      '.aaa-tabs{display:flex;gap:4px;padding:8px 12px 0}',
      '.aaa-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);padding:6px 12px;border-radius:8px 8px 0 0;cursor:pointer;font-size:13px}',
      '.aaa-tab[data-active="1"]{background:var(--dsw-specific-input-major,rgba(128,128,128,.14));color:var(--dsw-alias-label-primary)}',
      '.aaa-body{flex:1;overflow:auto;padding:14px 16px;font-size:13px;line-height:1.55}',
      '.aaa-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;margin-bottom:10px}',
      '.aaa-ok{color:var(--dsw-alias-state-success-primary,#3fae6a)}.aaa-bad{color:var(--dsw-alias-state-error-primary,#e0565f)}.aaa-dim{color:var(--dsw-alias-label-tertiary)}',
      '.aaa-row{display:flex;align-items:center;gap:8px;padding:6px 4px;border-radius:6px;cursor:pointer}',
      '.aaa-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.aaa-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:7px;padding:4px 10px;cursor:pointer;font-size:12px}',
      '.aaa-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.aaa-btn:disabled{opacity:.45;cursor:default}',
      '.aaa-select,.aaa-textarea{width:100%;box-sizing:border-box;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit}',
      '.aaa-textarea{min-height:90px;resize:vertical}',
      '.aaa-pre{white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;max-height:300px;overflow:auto;color:var(--dsw-alias-label-primary)}',
      '.aaa-tag{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.aaa-pick{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
      '.aaa-pick-card{display:flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.aaa-pick-on{border-color:var(--dsw-alias-state-success-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-success-primary)}',
      '.aaa-pick-off{opacity:.45;cursor:not-allowed}',
      '.aaa-cmp{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}',
      '.aaa-cmp-card{flex:1 1 250px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;background:var(--dsw-alias-bg-base)}',
      '.aaa-taskrow{display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px}',
      '.aaa-dot{width:8px;height:8px;border-radius:50%;flex:none}',
      '.aaa-taskout{margin:6px 0 10px 18px;}',
      '.aaa-modal{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999}',
      '.aaa-modal-card{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;max-width:760px;width:min(92vw,760px);max-height:82vh;overflow:auto;padding:16px;box-shadow:var(--dsw-shadow-lv3)}'
    ].join('\n');

    function ensureStyle() {
      if (document.getElementById('dsh-aa-style')) return;
      var el = document.createElement('style');
      el.id = 'dsh-aa-style';
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    // ---------- Agent 多选存储（跨标签共享 + localStorage 持久化） ----------
    var SEL_KEY = 'dsh.agentAlliance.selected.v1'
    function selLoad() { try { return JSON.parse(localStorage.getItem(SEL_KEY) || '[]') } catch (e) { return [] } }
    function selSave(arr) { try { localStorage.setItem(SEL_KEY, JSON.stringify(arr)) } catch (e) {} }

    function AgentPicker() {
      var s = react.useState({ list: null });
      var st = s[0], set = s[1];
      var sel = react.useState(selLoad());
      var selected = sel[0], setSelected = sel[1];
      react.useEffect(function () {
        getState().then(function (r) {
          var ps = (r.json && r.json.providers || []).filter(function (p) { return p.available !== false; });
          set({ list: ps });
          // 清理已下线的选中项
          var ids = ps.map(function (p) { return p.id; });
          var cleaned = selected.filter(function (x) { return ids.indexOf(x) >= 0; });
          if (cleaned.length !== selected.length) { setSelected(cleaned); selSave(cleaned); }
        }, function () { set({ list: [] }); });
      }, []);
      var toggle = function (id) {
        var next = selected.indexOf(id) >= 0 ? selected.filter(function (x) { return x !== id; }) : selected.concat([id]);
        setSelected(next); selSave(next);
      };
      var list = st.list;
      if (!list) return h('div', { className: 'aaa-dim', style: { marginBottom: '10px' } }, T('sess.loading'));
      return h('div', { className: 'aaa-pick' },
        h('span', { className: 'aaa-dim', style: { alignSelf: 'center' } }, T('pick.title') + '：'),
        list.length === 0 ? h('span', { className: 'aaa-dim' }, T('pick.none')) :
        list.map(function (p) {
          var on = selected.indexOf(p.id) >= 0;
          return h('div', {
            key: p.id,
            className: 'aaa-pick-card' + (on ? ' aaa-pick-on' : ''),
            onClick: function () { toggle(p.id); },
          },
            h('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, '●'),
            h('span', null, p.id),
            on ? h('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, '✓') : null);
        }));
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
        b.innerHTML = '<span>' + ICON + '</span><span data-dsh-aa-label>' + T('entry.label') + '</span>';
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
      var labelSpan = null
      if (entry) labelSpan = entry.querySelector('[data-dsh-aa-label]')
      return {
        dispose: function () { observer.disconnect(); if (entry) entry.remove(); entry = null },
        setLabel: function (text) { if (labelSpan && entry) labelSpan.textContent = text },
      }
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
              p.available ? h('span', { className: 'aaa-ok' }, T('state.online') + (p.version ? ' ' + p.version : ''))
                          : h('span', { className: 'aaa-bad' }, T('state.offline'))),
            p.detail ? h('div', { className: 'aaa-dim' }, String(p.detail).slice(0, 140)) : null);
        }));
    }

    function SessionsTab() {
      var s = react.useState({ providers: [], sessions: [], filter: '', content: null, busy: false, msg: '' , picked: [] });
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
        lastViewed = { provider: provider, extId: id };
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
          h('button', { className: 'aaa-btn', onClick: function () { set(function (c) { return Object.assign({}, c, { filter: '' }); }); load(''); } }, T('sess.all')),
          st.providers.map(function (p) {
            return h('button', { key: p.id, className: 'aaa-btn', onClick: function () { set(function (c) { return Object.assign({}, c, { filter: p.id }); }); load(p.id); } }, p.id);
          }),
          st.busy ? h('span', { className: 'aaa-dim' }, T('sess.loading')) : null),
        st.msg ? h('div', { style: { margin: '6px 0' } }, st.msg) : null,
        st.sessions.slice(0, 40).map(function (x) {
          return h('div', { key: x.provider + '/' + x.id, className: 'aaa-row' },
            h('span', { className: 'aaa-tag' }, x.provider),
            h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: x.id },
              (x.title || T('sess.none')) + (x.cwd ? '　@' + x.cwd : '')),
            x.imported ? h('span', { className: 'aaa-dim' }, T('sess.imported')) : null,
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }, onClick: function (e) { e.stopPropagation(); togglePick(x.id); } },
              h('input', { type: 'checkbox', checked: st.picked.indexOf(x.id) >= 0, onChange: function () {} }),
              h('span', { className: 'aaa-dim', style: { fontSize: '11px' } }, '选')),
            h('button', { className: 'aaa-btn', onClick: function () { openContent(x.provider, x.id); } }, T('sess.view')),
            h('button', { className: 'aaa-btn', disabled: !!x.imported, onClick: function () { doImport(x.provider, x.id); } }, x.imported ? T('sess.imported') : T('sess.import')));
        }),
        !st.sessions.length ? h('div', { className: 'aaa-dim' }, T('sess.none')) : null,
        st.picked.length ? h('div', { style: { margin: '8px 0' } },
          h('button', { className: 'aaa-btn', onClick: function () {
            var ids = st.picked.slice(); var doneN = 0; var lastId = '';
            (function nx(i) { if (i >= ids.length) { upd({ msg: '✅ 批量导入完成 ' + doneN + '/' + ids.length + (lastId ? ' · 末次 dshSessionId: ' + lastId : '') , picked: [] }); load(''); return; }
              var it = st.sessions.find(function (x) { return x.id === ids[i]; });
              if (!it) { nx(i + 1); return; }
              postImport(it.provider, it.id).then(function (r) { if ((r.json || {}).dshSessionId) lastId = r.json.dshSessionId; if ((r.json || {}).status === 'imported') doneN++; nx(i + 1); }, function () { nx(i + 1); });
            })(0);
          } }, T('batch.go') + '(' + ids.length + ')')) : null,
        st.content ? h('div', { className: 'aaa-modal', onClick: function (e) { if (e.target === e.currentTarget) set(function (c) { return Object.assign({}, c, { content: null }); }); } },
          h('div', { className: 'aaa-modal-card' },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' } },
              h('b', null, (st.content.data && st.content.data.title) || T('sess.preview')),
              h('button', { className: 'aaa-btn', onClick: function () { set(function (c) { return Object.assign({}, c, { content: null }); }); } }, T('common.close'))),
            st.content.error ? h('div', { className: 'aaa-bad' }, st.content.error)
              : st.content.loading ? h('div', { className: 'aaa-dim' }, T('sess.loading'))
              : ((st.content.data && st.content.data.messages) || []).length === 0 ? h('div', { className: 'aaa-dim' }, T('sess.none'))
              : ((st.content.data.messages) || []).map(function (m, mi) {
                  var mine = m.role === 'user';
                  return h('div', { key: mi, style: { display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', margin: '6px 0' } },
                    h('div', {
                      style: {
                        maxWidth: '86%', padding: '8px 12px', borderRadius: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        fontSize: '13px', lineHeight: '1.55',
                        background: mine ? 'var(--dsw-specific-input-major)' : 'var(--dsw-alias-bg-base)',
                        border: mine ? 'none' : '1px solid var(--dsw-alias-border-l1)',
                        color: 'var(--dsw-alias-label-primary)',
                      },
                    }, m.text));
                })))
          : null);
    }

    function DispatchTab() {
      var s = react.useState({ mode: 'single', provider: 'opencode', prompt: '', result: null, busy: false, broadcast: null, resume: false });
      var st = s[0], set = s[1];
      var upd = function (patch) { set(function (cur) { return Object.assign({}, cur, patch); }); };
      var avail = react.useState([]);
      var providers = avail[0];
      react.useEffect(function () {
        getState().then(function (r) {
          var ps = ((r.json && r.json.providers) || []).filter(function (p) { return p.available !== false; }).map(function (p) { return p.id; });
          if (ps.length) upd({ provider: ps.indexOf(st.provider) >= 0 ? st.provider : ps[0] });
        }, function () {});
      }, []);
      var run = function () {
        if (!st.prompt.trim()) return;
        if (st.mode === 'bc') {
          var sel = selLoad();
          if (!sel.length) { upd({ bcErr: T('bc.need') }); return; }
          upd({ busy: true, bcErr: null, broadcast: sel.map(function (p) { return { p: p, status: 'running' }; }), result: null });
          sel.forEach(function (p) {
              var t0 = Date.now();
            postDispatch({ provider: p, prompt: st.prompt }).then(function (r) {
              var entry = { p: p, status: r.status === 200 ? 'ok' : 'err', text: r.status === 200 ? r.json.text : (((r.json || {}).error) || ('HTTP ' + r.status)), sid: r.status === 200 ? r.json.externalSessionId : null, ms: Date.now() - t0 };
              set(function (cur) { var arr = (cur.broadcast || []).slice(); var i2 = arr.findIndex(function (x) { return x.p === p; }); if (i2 >= 0) arr[i2] = entry; return Object.assign({}, cur, { broadcast: arr }); });
            }, function () {
              set(function (cur) { var arr = (cur.broadcast || []).slice(); var i2 = arr.findIndex(function (x) { return x.p === p; }); if (i2 >= 0) arr[i2] = { p: p, status: 'err', text: '请求失败', ms: Date.now() - t0 }; return Object.assign({}, cur, { broadcast: arr }); });
            });
          });
          return;
        }
        upd({ busy: true, result: null });
        postDispatch({ provider: st.provider, prompt: st.prompt, resumeSessionId: st.resume && lastViewed ? lastViewed.extId : undefined }).then(function (r) {
          upd({ busy: false, result: r.status === 200
            ? ('[' + r.json.provider + (r.json.externalSessionId ? ' 会话 ' + r.json.externalSessionId : '') + ']\n' + r.json.text)
            : ('失败：' + ((r.json && r.json.error) || r.status)) });
        }, function () { upd({ busy: false, result: '请求失败' }); });
      };
      var copyText = function (text) {
        try { navigator.clipboard.writeText(text); } catch (e) {}
      };
      return h('div', null,
        h(AgentPicker),
        h('div', { style: { display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('div', { style: { display: 'flex', gap: '0' } },
            ['single', 'bc'].map(function (m) {
              var on = st.mode === m;
              return h('button', { key: m, className: 'aaa-btn', style: on ? { borderColor: 'var(--dsw-alias-state-success-primary)' } : {}, onClick: function () { upd({ mode: m }); } }, T(m === 'single' ? 'mode.single' : 'mode.bc'));
            })),
          st.mode === 'single' ? h('select', { className: 'aaa-select', style: { width: '160px' }, value: st.provider, onChange: function (e) { upd({ provider: e.target.value }); } },
            (providers.length ? providers : [st.provider]).map(function (p) { return h('option', { key: p, value: p }, p); })) : null,
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '5px' } },
            h('input', { type: 'checkbox', checked: !!st.resume, onChange: function (e) { upd({ resume: e.target.checked }); } }),
            h('span', { className: 'aaa-dim' }, '续聊上次查看的会话')),
          h('span', { className: 'aaa-dim' }, '⚠ 真实消耗该 agent 的 API 额度')),
        h('textarea', { className: 'aaa-textarea', placeholder: T('disp.ph'), value: st.prompt, onChange: function (e) { upd({ prompt: e.target.value }); } }),
        st.bcErr ? h('div', { className: 'aaa-bad', style: { marginTop: '8px' } }, st.bcErr) : null,
        h('div', { style: { marginTop: '8px' } },
          h('button', { className: 'aaa-btn', disabled: st.busy, onClick: run }, st.busy ? T('disp.running') : T('disp.run'))),
        st.mode === 'bc' && st.broadcast && !st.broadcast.some(function (x) { return x.status === 'running'; }) ? h('button', { className: 'aaa-btn', style: { marginLeft: '8px' }, onClick: function () {
          var rows = st.broadcast.map(function (x) { return '| ' + x.p + ' | ' + Math.round((x.ms || 0) / 100) / 10 + 's | ' + String(x.text || '').replace(/\|/g, '\\|').replace(/\n/g, ' ') + ' |'; });
          var md = '# Broadcast Compare\n\n| Agent | Time | Reply |\n| --- | --- | --- |\n' + rows.join('\n');
          try { navigator.clipboard.writeText(md); upd({ bcErr: '✅ Markdown 已复制' }); } catch (e2) {}
        } }, T('bc.export')) : null,
        st.mode === 'single' && st.result ? h('pre', { className: 'aaa-pre', style: { marginTop: '10px' } }, st.result) : null,
        st.mode === 'bc' && st.broadcast ? h('div', { className: 'aaa-cmp' },
          st.broadcast.map(function (x) {
            return h('div', { key: x.p, className: 'aaa-cmp-card' },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' } },
                h('b', null, x.p),
                x.status === 'ok' ? h('span', { className: 'aaa-dim' }, Math.round(x.ms / 100) / 10 + 's') :
                  x.status === 'running' ? h('span', { className: 'aaa-dim' }, '…') : h('span', { className: 'aaa-bad' }, '失败')),
              h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '13px', lineHeight: '1.55', maxHeight: '300px', overflow: 'auto', color: 'var(--dsw-alias-label-primary)' } },
                x.status === 'running' ? '…' : x.text),
              x.status === 'ok' ? h('div', { style: { marginTop: '6px', textAlign: 'right' } },
                h('button', { className: 'aaa-btn', onClick: function () { copyText(x.text); } }, T('bc.copy'))) : null);
          })) : null);
    }

    function RoundtableTab() {
      var s = react.useState({ prompt: '', jobId: null, running: false, output: null, err: null });
      var st = s[0], set = s[1];
      var upd = function (patch) { set(function (cur) { return Object.assign({}, cur, patch); }); };
      var poll = function (id) {
        fetch('/__agent-alliance/roundtable?id=' + encodeURIComponent(id))
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j.running) setTimeout(function () { poll(id); }, 1500);
            else upd({ running: false, output: j.output || ('失败：' + (j.detail || '未知')) });
          }, function () { upd({ running: false, output: '轮询失败' }); });
      };
      var run = function () {
        if (!st.prompt.trim()) return;
        upd({ busy: true });
        api('/roundtable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: st.prompt, providers: selLoad().length ? selLoad() : undefined }) })
          .then(function (r) {
            if (r.status !== 200) { upd({ busy: false, err: (r.json && r.json.error) || r.status }); return; }
            var rid = r.json.batchId || r.json.jobId;
            upd({ busy: false, jobId: rid, running: true });
            poll(rid);
          }, function () { upd({ busy: false, err: '请求失败' }); });
      };
      return h('div', null,
        h(AgentPicker),
        h('div', { className: 'aaa-dim', style: { marginBottom: '8px' } }, '⚠ 并发派发给选中的 agent（未选则全部可用），真实消耗各家额度'),
        h('textarea', { className: 'aaa-textarea', placeholder: '圆桌问题…', value: st.prompt, onChange: function (e) { upd({ prompt: e.target.value }); } }),
        h('div', { style: { marginTop: '8px' } },
          h('button', { className: 'aaa-btn', disabled: st.busy || st.running, onClick: run },
            st.running ? T('rt.running') : T('rt.launch')),
          st.jobId ? h('span', { className: 'aaa-dim', style: { marginLeft: '8px' } }, 'job ' + st.jobId) : null),
        st.err ? h('div', { className: 'aaa-bad', style: { marginTop: '8px' } }, st.err) : null,
        st.output ? h('pre', { className: 'aaa-pre', style: { marginTop: '10px' } }, st.output) : null);
    }

    function Panel(props) {
      var ts = react.useState('state');
      var tab = ts[0], setTab = ts[1];
      if (!props.open) return null;
      var body = tab === 'state' ? h(StateTab) : tab === 'sessions' ? h(SessionsTab) : tab === 'roundtable' ? h(RoundtableTab) : tab === 'tasks' ? h(TasksTab) : h(DispatchTab);
      return h('div', { className: 'aaa-overlay', onClick: props.onClose },
        h('div', { className: 'aaa-panel', onClick: function (e) { e.stopPropagation(); } },
          h('div', { className: 'aaa-head' },
            h('span', { className: 'aaa-title' }, T('panel.title')),
            h('button', { className: 'aaa-close', onClick: props.onClose }, T('common.close'))),
          h('div', { className: 'aaa-tabs' },
            ['state', 'sessions', 'dispatch', 'roundtable', 'tasks'].map(function (t) {
              return h('button', { key: t, className: 'aaa-tab', 'data-active': tab === t ? '1' : '0', onClick: function () { setTab(t); } },
                T('tab.' + t));
            })),
          h('div', { className: 'aaa-body' }, body)));
    }

    // ---------- 后台任务中心 ----------
    function TasksTab() {
      var s = react.useState({ tasks: null, openId: null, outs: {} });
      var st = s[0], set = s[1];
      var upd = function (patch) { set(function (cur) { return Object.assign({}, cur, patch); }); };
      react.useEffect(function () {
        var alive = true;
        var load = function () {
          api('/tasks').then(function (r) {
            if (!alive) return;
            var arr = (r.json && r.json.tasks) || [];
            arr.reverse(); // 最新在上
            upd({ tasks: arr });
          }, function () {});
        };
        load();
        var iv = setInterval(load, 2500);
        return function () { alive = false; clearInterval(iv); };
      }, []);
      var statusColor = function (st2) {
        if (st2 === 'running' || st2 === 'starting') return 'var(--dsw-alias-state-success-primary)';
        if (st2 === 'failed' || st2 === 'killed') return 'var(--dsw-alias-state-error-primary)';
        return 'var(--dsw-alias-label-tertiary)';
      };
      var toggleOut = function (id) {
        if (st.openId === id) { upd({ openId: null }); return; }
        upd({ openId: id });
        api('/task-output?id=' + encodeURIComponent(id)).then(function (r) {
          upd(function (cur) {
            var outs = Object.assign({}, cur.outs);
            outs[id] = r.status === 200 ? (r.json.text || T('sess.none')) : ((r.json && r.json.error) || ('HTTP ' + r.status));
            return Object.assign({}, cur, { outs: outs });
          });
        }, function () { upd(function (cur) { var o = Object.assign({}, cur.outs); o[id] = '请求失败'; return Object.assign({}, cur, { outs: o }); }); });
      };
      var kill = function (id) {
        api('/task-kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) }).then(function () {});
      };
      var tasks = st.tasks;
      return h('div', null,
        !tasks ? h('div', { className: 'aaa-dim' }, T('sess.loading')) :
        tasks.length === 0 ? h('div', { className: 'aaa-dim' }, T('task.none')) :
        tasks.map(function (tk) {
          return h('div', { key: tk.id },
            h('div', { className: 'aaa-taskrow' },
              h('span', { className: 'aaa-dot', style: { background: statusColor(tk.status) } }),
              h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                h('span', null, tk.label),
                h('span', { className: 'aaa-dim', style: { marginLeft: '8px', fontSize: '11px' } }, tk.id)),
              h('button', { className: 'aaa-btn', onClick: function () { toggleOut(tk.id); } }, T('task.output')),
              (tk.status === 'running' || tk.status === 'starting') ? h('button', { className: 'aaa-btn', onClick: function () { kill(tk.id); } }, T('task.kill')) : null),
            st.openId === tk.id ? h('pre', { className: 'aaa-pre aaa-taskout' }, st.outs[tk.id] !== undefined ? st.outs[tk.id] : T('sess.loading')) : null);
        }));
    }

    // ---------- 插件对象 ----------
    var inject = ['locale'];

    var sidebarLabelSetter = null
    var renderPanelRef = null

    function apply(ctx) {
      try {
        ctx.effect(function () {
          ctx.locale.register('agent-alliance', DICTS);
          T = ctx.locale.bind('agent-alliance');
          // 语言实时切换：跟随 locale/change 快照重渲染可见文案
          if (typeof ctx.on === 'function') {
            ctx.on('locale/change', function () {
              if (sidebarLabelSetter) sidebarLabelSetter(T('entry.label'))
              if (typeof renderPanelRef === 'function') renderPanelRef()
            })
          }
        }, 'agent-alliance: dicts');
        ctx.effect(function () {
          ensureStyle();
          var container = document.createElement('div');
          container.setAttribute('data-dsh-agent-alliance-root', '');
          document.body.appendChild(container);
          var root = reactDomClient.createRoot(container);
          var open = false;
          var renderPanel = function () { root.render(h(Panel, { open: open, onClose: function () { open = false; renderPanel(); } })); };
          var ui = mountSidebarEntry(function () { open = !open; renderPanel(); })
          var disposeEntry = ui.dispose
          sidebarLabelSetter = ui.setLabel
          renderPanelRef = renderPanel
          renderPanel();
          return function () {
            disposeEntry()
            sidebarLabelSetter = null
            renderPanelRef = null
            try { root.unmount(); } catch (e) { /* already gone */ }
            container.remove()
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
