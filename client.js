/**
 * dsh-agent-alliance — browser half.
 *
 * Registers the Agent Alliance page in the main column and its sidebar entry.
 * The Host half owns the /__agent-alliance routes; this bundle only renders
 * their data and owns one <style> element through its plugin effect.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-alliance',
  factory(require) {
    const React = require('react')
    const { createElement: h, useEffect, useRef, useState } = React

    const NS = 'agentAlliance'
    const JOB_POLL_MS = 1200
    const LIST_POLL_MS = 2500
    const EMPTY_OUTPUT = { text: '', job: null, lossy: false, error: null }

    // ── copy ────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        panel: 'Agent 协同',
        subtitle: '把 Codex、Claude Code、OpenCode、ZCode 当作外部协同方：查看可用后端、浏览并导入它们的会话、派发任务、发起多轮圆桌，并跟踪后台作业。',
        quotaWarning: '派发和圆桌会真实消耗目标 agent 的额度，并可能读写其工作目录里的文件；重要操作前请先确认。',
        retry: '重试',
        refresh: '刷新',
        loading: '正在读取…',
        unknown: '未知',
        'tab.state': '状态',
        'tab.sessions': '外部会话',
        'tab.dispatch': '派发',
        'tab.roundtable': '圆桌',
        'tab.tasks': '任务',
        'a11y.tabs': '面板分区',
        'error.request': '请求失败',
        'error.http': 'HTTP 状态 {status}',
        'duration.ms': '{value} ms',
        'duration.s': '{value} 秒',
        'state.providers': '可用后端',
        'state.recent': '最近派发',
        'state.empty': '宿主没有报告任何后端。',
        'state.noRecent': '本进程里还没有派发记录。',
        'state.available': '可用',
        'state.unavailable': '不可用',
        'state.ok': '成功',
        'state.failed': '失败',
        'sessions.filter': '后端筛选',
        'sessions.all': '全部后端',
        'sessions.search': '搜索',
        'sessions.searchPlaceholder': '按标题或路径筛选…',
        'sessions.refresh': '刷新列表',
        'sessions.total': '共 {count} 个会话',
        'sessions.empty': '没有符合筛选条件的外部会话。',
        'sessions.untitled': '（无标题）',
        'sessions.view': '预览',
        'sessions.import': '导入',
        'sessions.imported': '已导入',
        'sessions.importing': '导入中…',
        'sessions.previewTitle': '会话预览',
        'sessions.previewEmpty': '这个会话没有可显示的消息。',
        'sessions.closePreview': '关闭预览',
        'sessions.provider': '后端',
        'sessions.id': '会话 ID',
        'sessions.importOk': '已导入为 DSH 会话 {id}，共 {turns} 轮。',
        'sessions.importAlready': '该会话已导入过：{id}。',
        'sessions.importSkipped': '已跳过：{reason}',
        'sessions.importFailed': '导入失败：{reason}',
        'sessions.importUnknown': '导入完成，状态：{status}。',
        'role.user': '用户',
        'role.assistant': '助手',
        'role.tool': '工具',
        'role.system': '系统',
        'dispatch.provider': '后端',
        'dispatch.prompt': '任务描述',
        'dispatch.promptPlaceholder': '写清楚目标、约束与验收标准…',
        'dispatch.cwd': '工作目录',
        'dispatch.cwdPlaceholder': '留空则使用插件默认目录',
        'dispatch.model': '模型',
        'dispatch.modelPlaceholder': '留空则使用后端默认模型',
        'dispatch.background': '后台运行',
        'dispatch.backgroundHint': 'HTTP 派发路由是同步的；勾选后会把 background 标记一并发送，宿主支持时才真正转入后台作业。',
        'dispatch.run': '派发',
        'dispatch.running': '派发中…',
        'dispatch.result': '派发结果',
        'dispatch.session': '外部会话',
        'dispatch.backend': '执行路径',
        'dispatch.duration': '耗时',
        'dispatch.emptyPrompt': '请先填写任务描述。',
        'dispatch.noProviders': '宿主没有报告可用的后端，暂时无法派发。',
        'roundtable.participants': '参与后端',
        'roundtable.participantsHint': '不勾选任何后端时，宿主会对所有可用后端发起圆桌。',
        'roundtable.prompt': '圆桌问题',
        'roundtable.promptPlaceholder': '写出要多个 agent 共同回答的问题…',
        'roundtable.rounds': '轮次',
        'roundtable.cwd': '工作目录',
        'roundtable.cwdPlaceholder': '留空则使用插件默认目录',
        'roundtable.start': '发起圆桌',
        'roundtable.starting': '正在启动…',
        'roundtable.output': '圆桌输出',
        'roundtable.activeHint': '圆桌以无归属后台作业运行，输出会持续写进这里。',
        'roundtable.noProviders': '宿主没有报告可用的后端，暂时无法发起圆桌。',
        'roundtable.emptyPrompt': '请先填写圆桌问题。',
        'roundtable.kill': '终止作业',
        'tasks.list': '后台作业',
        'tasks.empty': '还没有 Agent Alliance 后台作业。',
        'tasks.view': '读取输出',
        'tasks.hide': '收起输出',
        'tasks.kill': '终止',
        'tasks.killing': '终止中…',
        'tasks.killDone': '终止请求：{outcome}',
        'tasks.output': '作业输出',
        'tasks.outputEmpty': '这个作业还没有输出。',
        'tasks.lossy': '作业缓冲区已丢弃较早的输出。',
        'tasks.progress': '进度',
        'kind.subagent': '官方子代理',
        'kind.cli': 'CLI',
        'backend.subagent': '官方子代理',
        'backend.cli': 'CLI',
        'status.running': '运行中',
        'status.starting': '启动中',
        'status.pending': '等待中',
        'status.completed': '已完成',
        'status.failed': '失败',
        'status.killed': '已终止',
        'status.cancelled': '已取消',
        'status.done': '完成',
      },
      en: {
        panel: 'Agent Alliance',
        subtitle: 'Treat Codex, Claude Code, OpenCode, and ZCode as external collaborators: inspect available backends, browse and import their sessions, dispatch tasks, run multi-round roundtables, and follow background jobs.',
        quotaWarning: 'Dispatch and roundtable runs spend the target agent quota and may read or write files in its working directory. Confirm before important work.',
        retry: 'Retry',
        refresh: 'Refresh',
        loading: 'Loading…',
        unknown: 'Unknown',
        'tab.state': 'State',
        'tab.sessions': 'External sessions',
        'tab.dispatch': 'Dispatch',
        'tab.roundtable': 'Roundtable',
        'tab.tasks': 'Tasks',
        'a11y.tabs': 'Panel sections',
        'error.request': 'Request failed',
        'error.http': 'HTTP status {status}',
        'duration.ms': '{value} ms',
        'duration.s': '{value} s',
        'state.providers': 'Providers',
        'state.recent': 'Recent dispatches',
        'state.empty': 'The host reported no providers.',
        'state.noRecent': 'No dispatch has been recorded in this process.',
        'state.available': 'Available',
        'state.unavailable': 'Unavailable',
        'state.ok': 'Succeeded',
        'state.failed': 'Failed',
        'sessions.filter': 'Provider filter',
        'sessions.all': 'All providers',
        'sessions.search': 'Search',
        'sessions.searchPlaceholder': 'Filter by title or path…',
        'sessions.refresh': 'Refresh list',
        'sessions.total': '{count} sessions',
        'sessions.empty': 'No external session matches this filter.',
        'sessions.untitled': '(untitled)',
        'sessions.view': 'Preview',
        'sessions.import': 'Import',
        'sessions.imported': 'Imported',
        'sessions.importing': 'Importing…',
        'sessions.previewTitle': 'Session preview',
        'sessions.previewEmpty': 'This session has no displayable messages.',
        'sessions.closePreview': 'Close preview',
        'sessions.provider': 'Provider',
        'sessions.id': 'Session ID',
        'sessions.importOk': 'Imported as DSH session {id} with {turns} turns.',
        'sessions.importAlready': 'This session was imported already: {id}.',
        'sessions.importSkipped': 'Import skipped: {reason}',
        'sessions.importFailed': 'Import failed: {reason}',
        'sessions.importUnknown': 'Import finished with status {status}.',
        'role.user': 'User',
        'role.assistant': 'Assistant',
        'role.tool': 'Tool',
        'role.system': 'System',
        'dispatch.provider': 'Provider',
        'dispatch.prompt': 'Prompt',
        'dispatch.promptPlaceholder': 'State the goal, constraints, and acceptance criteria…',
        'dispatch.cwd': 'Working directory',
        'dispatch.cwdPlaceholder': 'Leave empty to use the plugin default',
        'dispatch.model': 'Model',
        'dispatch.modelPlaceholder': 'Leave empty to use the backend default',
        'dispatch.background': 'Run in background',
        'dispatch.backgroundHint': 'The HTTP dispatch route is synchronous; the flag is sent with the request and only changes behavior on hosts that accept a background dispatch.',
        'dispatch.run': 'Dispatch',
        'dispatch.running': 'Dispatching…',
        'dispatch.result': 'Dispatch result',
        'dispatch.session': 'External session',
        'dispatch.backend': 'Execution path',
        'dispatch.duration': 'Duration',
        'dispatch.emptyPrompt': 'Enter a prompt before dispatching.',
        'dispatch.noProviders': 'The host reported no available provider, so nothing can be dispatched.',
        'roundtable.participants': 'Participants',
        'roundtable.participantsHint': 'With no participant selected, the host runs the roundtable over every available provider.',
        'roundtable.prompt': 'Question',
        'roundtable.promptPlaceholder': 'State the question the agents should answer together…',
        'roundtable.rounds': 'Rounds',
        'roundtable.cwd': 'Working directory',
        'roundtable.cwdPlaceholder': 'Leave empty to use the plugin default',
        'roundtable.start': 'Start roundtable',
        'roundtable.starting': 'Starting…',
        'roundtable.output': 'Roundtable output',
        'roundtable.activeHint': 'The roundtable runs as an unowned background job; its output streams into this panel.',
        'roundtable.noProviders': 'The host reported no available provider, so a roundtable cannot start.',
        'roundtable.emptyPrompt': 'Enter a question before starting the roundtable.',
        'roundtable.kill': 'Kill job',
        'tasks.list': 'Background jobs',
        'tasks.empty': 'No Agent Alliance background job exists yet.',
        'tasks.view': 'Read output',
        'tasks.hide': 'Hide output',
        'tasks.kill': 'Kill',
        'tasks.killing': 'Killing…',
        'tasks.killDone': 'Kill requested: {outcome}',
        'tasks.output': 'Job output',
        'tasks.outputEmpty': 'This job has produced no output yet.',
        'tasks.lossy': 'The job buffer dropped earlier output.',
        'tasks.progress': 'Progress',
        'kind.subagent': 'Official subagent',
        'kind.cli': 'CLI',
        'backend.subagent': 'Official subagent',
        'backend.cli': 'CLI',
        'status.running': 'Running',
        'status.starting': 'Starting',
        'status.pending': 'Pending',
        'status.completed': 'Completed',
        'status.failed': 'Failed',
        'status.killed': 'Killed',
        'status.cancelled': 'Cancelled',
        'status.done': 'Done',
      },
    }

    // ── theme ───────────────────────────────────────────────────────────────
    const CSS = `
.aall_page{display:flex;justify-content:center;box-sizing:border-box;height:100%;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.aall_shell{display:flex;flex-direction:column;width:100%;max-width:960px;min-height:0;height:100%;padding:0 clamp(20px,4vw,40px);box-sizing:border-box}
.aall_head{display:flex;flex-direction:column;gap:4px;padding:28px 0 12px;flex:none}
.aall_title{margin:0;font-size:20px;line-height:28px;font-weight:500;color:var(--dsw-alias-label-primary)}
.aall_subtitle{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.aall_warning{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}
.aall_tabs{display:flex;gap:2px;flex:none;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.aall_tab{appearance:none;margin-bottom:-1px;padding:8px 14px;border:0;border-bottom:2px solid transparent;background:none;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.aall_tab:hover{color:var(--dsw-alias-label-primary)}
.aall_tab[aria-selected='true']{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-label-primary)}
.aall_tab:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-border-l2));outline-offset:-2px;border-radius:4px}
.aall_body{flex:1;min-height:0;overflow:auto;padding:16px 0 48px}
.aall_stack{display:flex;flex-direction:column;gap:18px}
.aall_section{display:flex;flex-direction:column;gap:8px}
.aall_sectionHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.aall_sectionTitle{flex:1;margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.aall_list{display:flex;flex-direction:column;border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.aall_row{display:flex;align-items:center;flex-wrap:wrap;gap:10px;min-width:0;padding:7px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l1);font-size:12.5px;line-height:18px}
.aall_row:last-child{border-bottom:0}
.aall_row:hover{background:var(--dsw-alias-bg-layer-2)}
.aall_rowMain{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:2px}
.aall_rowTitle{display:flex;align-items:center;gap:8px;min-width:0}
.aall_rowName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.aall_rowSub{display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.aall_rowSub>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aall_rowEnd{display:flex;align-items:center;gap:6px;flex:none}
.aall_dim{color:var(--dsw-alias-label-tertiary)}
.aall_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.aall_tag{display:inline-flex;align-items:center;max-width:220px;padding:1px 7px;border-radius:99px;border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.aall_dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.aall_dot-ok{background:var(--dsw-alias-state-success-primary)}
.aall_dot-warn{background:var(--dsw-alias-state-warn-primary)}
.aall_dot-error{background:var(--dsw-alias-state-error-primary)}
.aall_ok{color:var(--dsw-alias-state-success-primary)}
.aall_warn{color:var(--dsw-alias-state-warn-primary)}
.aall_bad{color:var(--dsw-alias-state-error-primary)}
.aall_empty{padding:18px 14px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);text-align:center;border:0.5px dashed var(--dsw-alias-border-l1);border-radius:10px}
.aall_notice{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 11px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary)}
.aall_notice-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.aall_notice-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary)}
.aall_noticeText{font-weight:500}
.aall_noticeDetail{flex:1 1 180px;min-width:0;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;overflow-wrap:anywhere}
.aall_btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:5px 12px;font:inherit;font-size:12.5px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;cursor:pointer}
.aall_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.aall_btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-border-l2));outline-offset:2px}
.aall_btn:disabled{opacity:.5;cursor:default}
.aall_btn-primary{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}
.aall_btn-primary:hover:not(:disabled){background:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-label-secondary)}
.aall_btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.aall_btn-small{padding:3px 9px;font-size:12px;line-height:17px}
.aall_field{display:flex;flex-direction:column;gap:5px;flex:1;min-width:160px}
.aall_field-inline{flex:0 1 240px}
.aall_fieldRow{display:flex;gap:12px;flex-wrap:wrap}
.aall_label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.aall_hint{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.aall_input,.aall_select,.aall_textarea{width:100%;box-sizing:border-box;padding:6px 9px;font:inherit;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:0.5px solid var(--dsw-alias-border-l1);border-radius:7px}
.aall_input:focus-visible,.aall_select:focus-visible,.aall_textarea:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-border-l2));outline-offset:1px;border-color:var(--dsw-alias-border-l2)}
.aall_input::placeholder,.aall_textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.aall_textarea{min-height:110px;resize:vertical;font-family:inherit}
.aall_checkRow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.aall_check{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}
.aall_check input{width:15px;height:15px;accent-color:var(--dsw-alias-label-primary);cursor:pointer}
.aall_check input:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-border-l2));outline-offset:2px}
.aall_actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.aall_toolbar{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
.aall_toolbarEnd{display:flex;align-items:center;gap:8px;flex:none;padding-bottom:1px}
.aall_form{display:flex;flex-direction:column;gap:12px}
.aall_pills{display:flex;flex-wrap:wrap;gap:6px}
.aall_pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:99px;background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary);cursor:pointer}
.aall_pill[aria-pressed='true']{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.aall_pill:disabled{opacity:.5;cursor:default}
.aall_pill:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-border-l2));outline-offset:2px}
.aall_card{display:flex;flex-direction:column;gap:8px;padding:12px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent)}
.aall_cardHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.aall_cardTitle{flex:1;margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.aall_meta{display:flex;flex-direction:column;gap:3px}
.aall_metaRow{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:12px;font-size:12px;line-height:18px}
.aall_metaKey{color:var(--dsw-alias-label-secondary)}
.aall_metaValue{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.aall_messages{display:flex;flex-direction:column;gap:8px;max-height:360px;overflow:auto}
.aall_message{padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}
.aall_messageHead{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.aall_messageText{margin:0;font-size:12.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.aall_pre{margin:0;padding:10px;max-height:360px;overflow:auto;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.aall_loading{display:flex;align-items:center;gap:8px;padding:14px 4px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.aall_spinner{width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);animation:aall-spin .8s linear infinite;flex:none}
@keyframes aall-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.aall_spinner{animation-duration:2.4s}}
`

    // ── helpers ─────────────────────────────────────────────────────────────
    /** Local dictionary fallback: the slot renderer normally supplies `t`. */
    function localize(key, params) {
      let language = 'en'
      if (typeof document !== 'undefined' && document.documentElement !== null) {
        const tag = String(document.documentElement.lang || '').toLowerCase()
        if (tag.indexOf('zh') === 0) language = 'zh'
      }
      const template = DICT[language][key] === undefined ? DICT.en[key] : DICT[language][key]
      if (typeof template !== 'string') return key
      if (params === undefined || params === null) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => params[name] === undefined ? match : String(params[name]))
    }

    function queryString(params) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue
        search.set(key, String(value))
      }
      const text = search.toString()
      return text === '' ? '' : '?' + text
    }

    /** One JSON request against the Host half; rejects on any non-ok result. */
    async function request(path, init) {
      const options = { credentials: 'same-origin', cache: 'no-store' }
      if (init !== undefined) {
        if (typeof init.method === 'string') options.method = init.method
        if (init.body !== undefined) {
          options.body = init.body
          options.headers = { 'content-type': 'application/json' }
        }
      }
      const response = await fetch('/__agent-alliance' + path, options)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const failure = new Error(payload !== null && typeof payload.error === 'string' ? payload.error : '')
        failure.status = response.status
        if (payload !== null && payload.code !== undefined) failure.code = payload.code
        throw failure
      }
      return payload
    }

    function failureMessage(t, error) {
      if (error !== null && error !== undefined && typeof error.message === 'string' && error.message !== '') return error.message
      if (error !== null && error !== undefined && typeof error.status === 'number') return t('error.http', { status: error.status })
      return t('error.request')
    }

    /** Some Host builds nest a single payload under a named field; accept both. */
    function unwrap(payload, field) {
      if (payload === null || typeof payload !== 'object') return {}
      const nested = payload[field]
      return nested !== null && typeof nested === 'object' ? nested : payload
    }

    function dictLabel(t, prefix, value) {
      if (value === undefined || value === null || value === '') return t('unknown')
      const key = prefix + String(value)
      const label = t(key)
      return typeof label === 'string' && label !== key ? label : String(value)
    }

    function durationText(t, ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value < 0) return t('unknown')
      if (value < 1000) return t('duration.ms', { value: Math.round(value) })
      return t('duration.s', { value: (value / 1000).toFixed(1) })
    }

    function stampOf(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      const parsed = Date.parse(String(value))
      return Number.isFinite(parsed) ? parsed : 0
    }

    function instantText(t, value) {
      if (value === undefined || value === null || value === '') return t('unknown')
      const stamp = stampOf(value)
      if (stamp === 0) return String(value)
      const tag = typeof document === 'undefined' || document.documentElement === null
        ? undefined
        : String(document.documentElement.lang || '') || undefined
      try {
        return new Date(stamp).toLocaleString(tag)
      } catch {
        return new Date(stamp).toLocaleString()
      }
    }

    function isActiveJob(job) {
      if (job === null || job === undefined) return false
      const status = String(job.status)
      return status === 'running' || status === 'starting' || status === 'pending'
    }

    function jobDotClass(job) {
      const status = job === null || job === undefined ? '' : String(job.status)
      if (status === 'running') return 'aall_dot aall_dot-ok'
      if (status === 'starting' || status === 'pending') return 'aall_dot aall_dot-warn'
      if (status === 'failed' || status === 'killed' || status === 'cancelled') return 'aall_dot aall_dot-error'
      return 'aall_dot'
    }

    /** Read one resource keyed by `deps`; `retry` re-runs the same read. */
    function useLoad(load, deps) {
      const [state, setState] = useState({ status: 'loading' })
      const [attempt, setAttempt] = useState(0)
      const loadRef = useRef(load)
      loadRef.current = load
      useEffect(() => {
        let live = true
        setState({ status: 'loading' })
        void (async () => {
          try {
            const data = await loadRef.current()
            if (live) setState({ status: 'ready', data })
          } catch (error) {
            if (live) setState({ status: 'error', error })
          }
        })()
        return () => { live = false }
      }, deps.concat([attempt]))
      return { state, retry: () => setAttempt((value) => value + 1) }
    }

    /** Poll one job's output cursor while it is active. */
    function useJobOutput(jobId, attempt) {
      const [state, setState] = useState(EMPTY_OUTPUT)
      useEffect(() => {
        if (jobId === undefined || jobId === null || jobId === '') {
          setState(EMPTY_OUTPUT)
          return undefined
        }
        let live = true
        let from = 0
        let timer = null
        let text = ''
        setState(EMPTY_OUTPUT)
        const tick = () => {
          request('/tasks/output' + queryString({ id: jobId, from })).then((page) => {
            if (!live) return
            const chunks = Array.isArray(page.chunks) ? page.chunks : []
            for (const chunk of chunks) {
              if (chunk !== null && typeof chunk === 'object' && typeof chunk.text === 'string') text += chunk.text
            }
            const next = Number(page.next)
            if (Number.isFinite(next) && next >= 0) from = next
            setState({
              text,
              job: page.job === undefined ? null : page.job,
              lossy: page.lossy === true,
              error: null,
            })
            if (isActiveJob(page.job)) timer = setTimeout(tick, JOB_POLL_MS)
          }, (error) => {
            if (!live) return
            setState({ text, job: null, lossy: false, error })
          })
        }
        tick()
        return () => {
          live = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [jobId, attempt])
      return state
    }

    // ── primitives ──────────────────────────────────────────────────────────
    function Loading({ t }) {
      return h('div', { className: 'aall_loading', role: 'status' },
        h('span', { className: 'aall_spinner', 'aria-hidden': true }),
        t('loading'))
    }

    function Empty({ t, text }) {
      return h('div', { className: 'aall_empty' }, text)
    }

    function Notice({ tone, text }) {
      const className = tone === 'error'
        ? 'aall_notice aall_notice-error'
        : tone === 'warn' ? 'aall_notice aall_notice-warn' : 'aall_notice'
      return h('div', { className, role: 'status' }, text)
    }

    function ErrorRow({ t, message, onRetry }) {
      return h('div', { className: 'aall_notice aall_notice-error', role: 'alert' },
        h('span', { className: 'aall_noticeText' }, t('error.request')),
        message === undefined || message === null || message === '' ? null : h('span', { className: 'aall_noticeDetail' }, message),
        onRetry === undefined ? null : h('button', { type: 'button', className: 'aall_btn aall_btn-small', onClick: onRetry }, t('retry')))
    }

    function Field({ label, children }) {
      return h('label', { className: 'aall_field' },
        h('span', { className: 'aall_label' }, label),
        children)
    }

    function MetaRow({ label, children }) {
      return h('div', { className: 'aall_metaRow' },
        h('span', { className: 'aall_metaKey' }, label),
        h('span', { className: 'aall_metaValue' }, children))
    }

    /** Presentational job output card shared by the roundtable and tasks tabs. */
    function OutputCard({ t, output, title, emptyText, onRetry, actions }) {
      const job = output.job
      return h('section', { className: 'aall_card' },
        h('div', { className: 'aall_cardHead' },
          h('h3', { className: 'aall_cardTitle' }, title),
          job === null || job === undefined ? null : h('span', { className: jobDotClass(job), 'aria-hidden': true }),
          job === null || job === undefined ? null : h('span', { className: 'aall_tag' }, dictLabel(t, 'status.', job.status)),
          job === null || job === undefined || job.progress === undefined || job.progress === null || job.progress === ''
            ? null
            : h('span', { className: 'aall_dim aall_mono', title: t('tasks.progress') }, String(job.progress)),
          job === null || job === undefined || !job.label ? null : h('span', { className: 'aall_dim aall_mono' }, String(job.label)),
          actions === undefined ? null : actions),
        output.lossy ? h('p', { className: 'aall_hint' }, t('tasks.lossy')) : null,
        output.error !== null && output.error !== undefined
          ? h(ErrorRow, { t, message: failureMessage(t, output.error), onRetry })
          : output.text === ''
            ? h(Empty, { t, text: emptyText })
            : h('pre', { className: 'aall_pre' }, output.text))
    }

    // ── state tab ───────────────────────────────────────────────────────────
    function StateTab({ t }) {
      const { state, retry } = useLoad(() => request('/state'), [])
      if (state.status === 'loading') return h(Loading, { t })
      if (state.status === 'error') return h(ErrorRow, { t, message: failureMessage(t, state.error), onRetry: retry })
      const providers = Array.isArray(state.data.providers) ? state.data.providers : []
      const recent = Array.isArray(state.data.recentDispatches) ? state.data.recentDispatches : []
      return h('div', { className: 'aall_stack' },
        h('section', { className: 'aall_section' },
          h('div', { className: 'aall_sectionHead' },
            h('h2', { className: 'aall_sectionTitle' }, t('state.providers')),
            h('button', { type: 'button', className: 'aall_btn aall_btn-small', onClick: retry }, t('refresh'))),
          providers.length === 0
            ? h(Empty, { t, text: t('state.empty') })
            : h('div', { className: 'aall_list' }, providers.map((provider, index) => {
              const id = provider !== null && provider !== undefined && provider.id !== undefined ? String(provider.id) : String(index)
              const available = provider !== null && provider !== undefined && provider.available === true
              return h('div', { key: id, className: 'aall_row' },
                h('span', { className: available ? 'aall_dot aall_dot-ok' : 'aall_dot aall_dot-error', 'aria-hidden': true }),
                h('div', { className: 'aall_rowMain' },
                  h('div', { className: 'aall_rowTitle' },
                    h('span', { className: 'aall_rowName' }, provider !== null && provider !== undefined && provider.label ? String(provider.label) : id),
                    h('span', { className: 'aall_mono aall_dim' }, id)),
                  provider !== null && provider !== undefined && provider.detail ? h('div', { className: 'aall_rowSub' }, String(provider.detail)) : null),
                h('span', { className: 'aall_tag' }, dictLabel(t, 'kind.', provider === null || provider === undefined ? undefined : provider.kind)),
                h('span', { className: available ? 'aall_ok' : 'aall_bad' }, available ? t('state.available') : t('state.unavailable')))
            }))),
        h('section', { className: 'aall_section' },
          h('div', { className: 'aall_sectionHead' }, h('h2', { className: 'aall_sectionTitle' }, t('state.recent'))),
          recent.length === 0
            ? h(Empty, { t, text: t('state.noRecent') })
            : h('div', { className: 'aall_list' }, recent.map((entry, index) => {
              const record = entry !== null && entry !== undefined ? entry : {}
              const ok = record.ok === true
              const ms = record.durationMs === undefined ? record.ms : record.durationMs
              return h('div', { key: String(index), className: 'aall_row' },
                h('span', { className: ok ? 'aall_dot aall_dot-ok' : 'aall_dot aall_dot-error', 'aria-hidden': true }),
                h('div', { className: 'aall_rowMain' },
                  h('div', { className: 'aall_rowTitle' }, h('span', { className: 'aall_rowName' }, record.prompt ? String(record.prompt) : t('unknown'))),
                  h('div', { className: 'aall_rowSub' },
                    h('span', { className: 'aall_mono' }, record.provider ? String(record.provider) : t('unknown')),
                    record.error ? h('span', { className: 'aall_bad' }, String(record.error)) : null)),
                h('span', { className: 'aall_dim' }, instantText(t, record.at)),
                h('span', { className: ok ? 'aall_ok' : 'aall_bad' }, ok ? t('state.ok') : t('state.failed')),
                h('span', { className: 'aall_dim aall_mono' }, durationText(t, ms)))
            }))))
    }

    // ── external sessions tab ───────────────────────────────────────────────
    function importOutcome(t, result) {
      const status = result !== null && result !== undefined ? result.status : undefined
      if (status === 'imported') {
        return {
          tone: 'ok',
          text: t('sessions.importOk', {
            id: result.dshSessionId === undefined || result.dshSessionId === null ? t('unknown') : String(result.dshSessionId),
            turns: result.turns === undefined || result.turns === null ? 0 : result.turns,
          }),
        }
      }
      if (status === 'already-imported') {
        return {
          tone: 'ok',
          text: t('sessions.importAlready', {
            id: result.dshSessionId === undefined || result.dshSessionId === null ? t('unknown') : String(result.dshSessionId),
          }),
        }
      }
      if (status === 'skipped') {
        return { tone: 'warn', text: t('sessions.importSkipped', { reason: result.reason === undefined ? t('unknown') : String(result.reason) }) }
      }
      if (status === 'failed') {
        const reason = result.reason !== undefined ? String(result.reason) : result.error !== undefined ? String(result.error) : t('unknown')
        return { tone: 'error', text: t('sessions.importFailed', { reason }) }
      }
      return { tone: 'warn', text: t('sessions.importUnknown', { status: status === undefined ? t('unknown') : String(status) }) }
    }

    function SessionPreview({ t, provider, id, onClose }) {
      const { state, retry } = useLoad(
        () => request('/session-content' + queryString({ provider, id, maxChars: 12000 })),
        [provider, id],
      )
      const data = state.status === 'ready' ? unwrap(state.data, 'content') : null
      const messages = data !== null && Array.isArray(data.messages) ? data.messages : []
      return h('section', { className: 'aall_card' },
        h('div', { className: 'aall_cardHead' },
          h('h3', { className: 'aall_cardTitle' }, data !== null && data.title ? String(data.title) : t('sessions.previewTitle')),
          h('button', { type: 'button', className: 'aall_btn aall_btn-small', onClick: onClose }, t('sessions.closePreview'))),
        h('div', { className: 'aall_meta' },
          h(MetaRow, { label: t('sessions.provider') }, provider),
          h(MetaRow, { label: t('sessions.id') }, id)),
        state.status === 'loading' ? h(Loading, { t }) : null,
        state.status === 'error' ? h(ErrorRow, { t, message: failureMessage(t, state.error), onRetry: retry }) : null,
        state.status === 'ready' && messages.length === 0 ? h(Empty, { t, text: t('sessions.previewEmpty') }) : null,
        state.status === 'ready' && messages.length > 0
          ? h('div', { className: 'aall_messages' }, messages.map((message, index) => {
            const role = message !== null && message !== undefined ? message.role : undefined
            const text = message !== null && message !== undefined && typeof message.text === 'string' ? message.text : ''
            return h('div', { key: String(index), className: 'aall_message' },
              h('div', { className: 'aall_messageHead' }, h('span', { className: 'aall_tag' }, dictLabel(t, 'role.', role))),
              h('p', { className: 'aall_messageText' }, text))
          }))
          : null)
    }

    function SessionsTab({ t }) {
      const [provider, setProvider] = useState('')
      const [draftQuery, setDraftQuery] = useState('')
      const [query, setQuery] = useState('')
      const [preview, setPreview] = useState(null)
      const [importing, setImporting] = useState('')
      const [notice, setNotice] = useState(null)
      const directory = useLoad(() => request('/state'), [])
      const list = useLoad(
        () => request('/sessions' + queryString({ provider, query, limit: 50 })),
        [provider, query],
      )
      const providers = directory.state.status === 'ready' && Array.isArray(directory.state.data.providers)
        ? directory.state.data.providers.filter((entry) => entry !== null && entry !== undefined && entry.available === true)
        : []
      const sessions = list.state.status === 'ready' && Array.isArray(list.state.data.sessions) ? list.state.data.sessions : []
      const total = list.state.status === 'ready' && list.state.data.total !== undefined ? list.state.data.total : sessions.length

      async function importSession(entry) {
        const key = String(entry.provider) + '/' + String(entry.id)
        setImporting(key)
        setNotice(null)
        try {
          const result = await request('/import', {
            method: 'POST',
            body: JSON.stringify({ provider: entry.provider, sessionId: entry.id }),
          })
          setNotice(importOutcome(t, unwrap(result, 'result')))
          list.retry()
        } catch (error) {
          setNotice({ tone: 'error', text: failureMessage(t, error), retry: () => { void importSession(entry) } })
        } finally {
          setImporting('')
        }
      }

      function sessionRow(entry) {
        const providerId = entry !== null && entry !== undefined && entry.provider !== undefined ? entry.provider : undefined
        const sessionId = entry !== null && entry !== undefined && entry.id !== undefined ? entry.id : undefined
        const key = String(providerId) + '/' + String(sessionId)
        const imported = entry !== null && entry !== undefined && entry.imported === true
        const busy = importing === key
        return h('div', { key, className: 'aall_row' },
          h('span', { className: 'aall_tag' }, providerId === undefined ? t('unknown') : String(providerId)),
          h('div', { className: 'aall_rowMain' },
            h('div', { className: 'aall_rowTitle' },
              h('span', { className: 'aall_rowName' }, entry !== null && entry !== undefined && entry.title ? String(entry.title) : t('sessions.untitled')),
              imported ? h('span', { className: 'aall_tag' }, t('sessions.imported')) : null),
            h('div', { className: 'aall_rowSub' },
              h('span', { className: 'aall_mono' }, sessionId === undefined ? t('unknown') : String(sessionId)),
              entry !== null && entry !== undefined && entry.cwd ? h('span', { className: 'aall_dim' }, String(entry.cwd)) : null)),
          h('span', { className: 'aall_dim' }, entry !== null && entry !== undefined && entry.createdAt !== undefined && entry.createdAt !== null
            ? instantText(t, entry.createdAt)
            : t('unknown')),
          h('div', { className: 'aall_rowEnd' },
            h('button', {
              type: 'button',
              className: 'aall_btn aall_btn-small',
              onClick: () => setPreview({ provider: providerId, id: sessionId }),
            }, t('sessions.view')),
            h('button', {
              type: 'button',
              className: 'aall_btn aall_btn-small',
              disabled: imported || busy,
              onClick: () => { void importSession(entry) },
            }, busy ? t('sessions.importing') : t('sessions.import'))))
      }

      return h('div', { className: 'aall_stack' },
        h('form', {
          className: 'aall_toolbar',
          onSubmit: (event) => { event.preventDefault(); setQuery(draftQuery) },
        },
          h('label', { className: 'aall_field aall_field-inline' },
            h('span', { className: 'aall_label' }, t('sessions.filter')),
            h('select', {
              className: 'aall_select',
              value: provider,
              onChange: (event) => setProvider(event.target.value),
            },
              h('option', { value: '' }, t('sessions.all')),
              providers.map((entry) => h('option', { key: String(entry.id), value: String(entry.id) },
                entry.label ? String(entry.label) : String(entry.id))))),
          h('label', { className: 'aall_field aall_field-inline' },
            h('span', { className: 'aall_label' }, t('sessions.search')),
            h('input', {
              className: 'aall_input',
              type: 'search',
              value: draftQuery,
              placeholder: t('sessions.searchPlaceholder'),
              onChange: (event) => setDraftQuery(event.target.value),
            })),
          h('div', { className: 'aall_toolbarEnd' },
            h('button', { type: 'submit', className: 'aall_btn' }, t('sessions.search')),
            h('button', { type: 'button', className: 'aall_btn', onClick: list.retry }, t('sessions.refresh')))),
        directory.state.status === 'error'
          ? h(ErrorRow, { t, message: failureMessage(t, directory.state.error), onRetry: directory.retry })
          : null,
        notice === null
          ? null
          : notice.tone === 'error' && notice.retry !== undefined
            ? h(ErrorRow, { t, message: notice.text, onRetry: notice.retry })
            : h(Notice, { tone: notice.tone, text: notice.text }),
        list.state.status === 'loading' ? h(Loading, { t }) : null,
        list.state.status === 'error' ? h(ErrorRow, { t, message: failureMessage(t, list.state.error), onRetry: list.retry }) : null,
        list.state.status === 'ready' && sessions.length === 0 ? h(Empty, { t, text: t('sessions.empty') }) : null,
        list.state.status === 'ready' && sessions.length > 0
          ? h('section', { className: 'aall_section' },
            h('div', { className: 'aall_sectionHead' },
              h('h2', { className: 'aall_sectionTitle' }, t('sessions.total', { count: total }))),
            h('div', { className: 'aall_list' }, sessions.map(sessionRow)))
          : null,
        preview === null
          ? null
          : h(SessionPreview, {
            t,
            provider: preview.provider === undefined ? '' : String(preview.provider),
            id: preview.id === undefined ? '' : String(preview.id),
            onClose: () => setPreview(null),
          }))
    }

    // ── dispatch tab ────────────────────────────────────────────────────────
    function DispatchTab({ t }) {
      const directory = useLoad(() => request('/state'), [])
      const [providerId, setProviderId] = useState('')
      const [prompt, setPrompt] = useState('')
      const [cwd, setCwd] = useState('')
      const [model, setModel] = useState('')
      const [background, setBackground] = useState(false)
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [notice, setNotice] = useState(null)
      const providers = directory.state.status === 'ready' && Array.isArray(directory.state.data.providers)
        ? directory.state.data.providers.filter((entry) => entry !== null && entry !== undefined && entry.available === true)
        : []
      const availableIds = providers.map((entry) => String(entry.id))
      const selectedProvider = availableIds.indexOf(providerId) >= 0
        ? providerId
        : availableIds.length > 0 ? availableIds[0] : ''

      async function run() {
        if (prompt.trim() === '') {
          setNotice({ tone: 'warn', text: t('dispatch.emptyPrompt') })
          return
        }
        if (selectedProvider === '') {
          setNotice({ tone: 'warn', text: t('dispatch.noProviders') })
          return
        }
        setBusy(true)
        setNotice(null)
        setResult(null)
        try {
          const payload = { provider: selectedProvider, prompt }
          if (cwd.trim() !== '') payload.cwd = cwd.trim()
          if (model.trim() !== '') payload.model = model.trim()
          if (background) payload.background = true
          const data = await request('/dispatch', { method: 'POST', body: JSON.stringify(payload) })
          setResult(data)
        } catch (error) {
          setNotice({ tone: 'error', text: failureMessage(t, error), retry: () => { void run() } })
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'aall_stack' },
        directory.state.status === 'loading' ? h(Loading, { t }) : null,
        directory.state.status === 'error'
          ? h(ErrorRow, { t, message: failureMessage(t, directory.state.error), onRetry: directory.retry })
          : null,
        directory.state.status === 'ready' && availableIds.length === 0
          ? h(Notice, { tone: 'warn', text: t('dispatch.noProviders') })
          : null,
        notice === null
          ? null
          : notice.retry !== undefined
            ? h(ErrorRow, { t, message: notice.text, onRetry: notice.retry })
            : h(Notice, { tone: notice.tone, text: notice.text }),
        h('form', {
          className: 'aall_form',
          onSubmit: (event) => { event.preventDefault(); void run() },
        },
          h(Field, { label: t('dispatch.provider') },
            h('select', {
              className: 'aall_select',
              value: selectedProvider,
              disabled: busy || availableIds.length === 0,
              onChange: (event) => setProviderId(event.target.value),
            },
              providers.map((entry) => h('option', { key: String(entry.id), value: String(entry.id) },
                entry.label ? String(entry.label) : String(entry.id))))),
          h(Field, { label: t('dispatch.prompt') },
            h('textarea', {
              className: 'aall_textarea',
              value: prompt,
              disabled: busy,
              placeholder: t('dispatch.promptPlaceholder'),
              onChange: (event) => setPrompt(event.target.value),
            })),
          h('div', { className: 'aall_fieldRow' },
            h(Field, { label: t('dispatch.cwd') },
              h('input', {
                className: 'aall_input',
                type: 'text',
                value: cwd,
                disabled: busy,
                placeholder: t('dispatch.cwdPlaceholder'),
                onChange: (event) => setCwd(event.target.value),
              })),
            h(Field, { label: t('dispatch.model') },
              h('input', {
                className: 'aall_input',
                type: 'text',
                value: model,
                disabled: busy,
                placeholder: t('dispatch.modelPlaceholder'),
                onChange: (event) => setModel(event.target.value),
              }))),
          h('div', { className: 'aall_checkRow' },
            h('label', { className: 'aall_check' },
              h('input', {
                type: 'checkbox',
                checked: background,
                disabled: busy,
                onChange: (event) => setBackground(event.target.checked),
              }),
              h('span', null, t('dispatch.background')))),
          h('p', { className: 'aall_hint' }, t('dispatch.backgroundHint')),
          h('div', { className: 'aall_actions' },
            h('button', {
              type: 'submit',
              className: 'aall_btn aall_btn-primary',
              disabled: busy || availableIds.length === 0,
            }, busy ? t('dispatch.running') : t('dispatch.run')))),
        result === null
          ? null
          : h('section', { className: 'aall_card' },
            h('div', { className: 'aall_cardHead' },
              h('h3', { className: 'aall_cardTitle' }, t('dispatch.result'))),
            h('div', { className: 'aall_meta' },
              h(MetaRow, { label: t('dispatch.provider') }, result.provider === undefined ? t('unknown') : String(result.provider)),
              h(MetaRow, { label: t('dispatch.backend') }, dictLabel(t, 'backend.', result.backend)),
              h(MetaRow, { label: t('dispatch.duration') }, durationText(t, result.durationMs)),
              result.externalSessionId === undefined || result.externalSessionId === null
                ? null
                : h(MetaRow, { label: t('dispatch.session') }, String(result.externalSessionId))),
            h('pre', { className: 'aall_pre' }, typeof result.text === 'string' ? result.text : '')))
    }

    // ── roundtable tab ──────────────────────────────────────────────────────
    /** Hosts without a jobs service answer a roundtable inline instead of an id. */
    function inlineOutput(t, text) {
      return h('section', { className: 'aall_card' },
        h('div', { className: 'aall_cardHead' }, h('h3', { className: 'aall_cardTitle' }, t('roundtable.output'))),
        h('pre', { className: 'aall_pre' }, text))
    }

    function RoundtableTab({ t }) {
      const directory = useLoad(() => request('/state'), [])
      const [selected, setSelected] = useState([])
      const [prompt, setPrompt] = useState('')
      const [rounds, setRounds] = useState('1')
      const [cwd, setCwd] = useState('')
      const [jobId, setJobId] = useState('')
      const [inlineText, setInlineText] = useState('')
      const [busy, setBusy] = useState(false)
      const [killing, setKilling] = useState(false)
      const [outputAttempt, setOutputAttempt] = useState(0)
      const [notice, setNotice] = useState(null)
      const providers = directory.state.status === 'ready' && Array.isArray(directory.state.data.providers)
        ? directory.state.data.providers.filter((entry) => entry !== null && entry !== undefined && entry.available === true)
        : []
      const output = useJobOutput(jobId, outputAttempt)
      const active = isActiveJob(output.job)

      function toggle(id) {
        setSelected((current) => current.indexOf(id) >= 0
          ? current.filter((value) => value !== id)
          : current.concat([id]))
      }

      async function start() {
        if (prompt.trim() === '') {
          setNotice({ tone: 'warn', text: t('roundtable.emptyPrompt') })
          return
        }
        setBusy(true)
        setNotice(null)
        setJobId('')
        setInlineText('')
        try {
          const payload = {
            prompt,
            providers: selected.length > 0 ? selected : undefined,
            rounds: Number(rounds),
          }
          if (cwd.trim() !== '') payload.cwd = cwd.trim()
          const data = await request('/roundtable', { method: 'POST', body: JSON.stringify(payload) })
          setJobId(data.jobId === undefined || data.jobId === null ? '' : String(data.jobId))
          setInlineText(typeof data.text === 'string' ? data.text : '')
        } catch (error) {
          setNotice({ tone: 'error', text: failureMessage(t, error), retry: () => { void start() } })
        } finally {
          setBusy(false)
        }
      }

      async function cancelJob() {
        if (jobId === '') return
        setKilling(true)
        try {
          const data = await request('/tasks/kill', {
            method: 'POST',
            body: JSON.stringify({ id: jobId, reason: 'panel' }),
          })
          setNotice({
            tone: 'ok',
            text: t('tasks.killDone', { outcome: data.outcome === undefined ? t('unknown') : String(data.outcome) }),
          })
          setOutputAttempt((value) => value + 1)
        } catch (error) {
          setNotice({ tone: 'error', text: failureMessage(t, error), retry: () => { void cancelJob() } })
        } finally {
          setKilling(false)
        }
      }

      return h('div', { className: 'aall_stack' },
        directory.state.status === 'loading' ? h(Loading, { t }) : null,
        directory.state.status === 'error'
          ? h(ErrorRow, { t, message: failureMessage(t, directory.state.error), onRetry: directory.retry })
          : null,
        h('section', { className: 'aall_section' },
          h('div', { className: 'aall_sectionHead' },
            h('h2', { className: 'aall_sectionTitle' }, t('roundtable.participants'))),
          providers.length === 0
            ? h(Empty, { t, text: t('roundtable.noProviders') })
            : h('div', { className: 'aall_pills', role: 'group', 'aria-label': t('roundtable.participants') },
              providers.map((entry) => {
                const id = String(entry.id)
                const on = selected.indexOf(id) >= 0
                return h('button', {
                  key: id,
                  type: 'button',
                  className: 'aall_pill',
                  'aria-pressed': on ? 'true' : 'false',
                  disabled: busy,
                  onClick: () => toggle(id),
                }, entry.label ? String(entry.label) : id)
              })),
          h('p', { className: 'aall_hint' }, t('roundtable.participantsHint'))),
        notice === null
          ? null
          : notice.retry !== undefined
            ? h(ErrorRow, { t, message: notice.text, onRetry: notice.retry })
            : h(Notice, { tone: notice.tone, text: notice.text }),
        h('form', {
          className: 'aall_form',
          onSubmit: (event) => { event.preventDefault(); void start() },
        },
          h(Field, { label: t('roundtable.prompt') },
            h('textarea', {
              className: 'aall_textarea',
              value: prompt,
              disabled: busy,
              placeholder: t('roundtable.promptPlaceholder'),
              onChange: (event) => setPrompt(event.target.value),
            })),
          h('div', { className: 'aall_fieldRow' },
            h(Field, { label: t('roundtable.rounds') },
              h('select', {
                className: 'aall_select',
                value: rounds,
                disabled: busy,
                onChange: (event) => setRounds(event.target.value),
              }, ['1', '2', '3'].map((value) => h('option', { key: value, value }, value)))),
            h(Field, { label: t('roundtable.cwd') },
              h('input', {
                className: 'aall_input',
                type: 'text',
                value: cwd,
                disabled: busy,
                placeholder: t('roundtable.cwdPlaceholder'),
                onChange: (event) => setCwd(event.target.value),
              }))),
          h('p', { className: 'aall_hint' }, t('roundtable.activeHint')),
          h('div', { className: 'aall_actions' },
            h('button', {
              type: 'submit',
              className: 'aall_btn aall_btn-primary',
              disabled: busy || providers.length === 0,
            }, busy ? t('roundtable.starting') : t('roundtable.start')))),
        jobId === ''
          ? inlineText === '' ? null : inlineOutput(t, inlineText)
          : h(OutputCard, {
            t,
            output,
            title: t('roundtable.output'),
            emptyText: t('tasks.outputEmpty'),
            onRetry: () => setOutputAttempt((value) => value + 1),
            actions: active
              ? h('button', {
                type: 'button',
                className: 'aall_btn aall_btn-small aall_btn-danger',
                disabled: killing,
                onClick: () => { void cancelJob() },
              }, killing ? t('tasks.killing') : t('roundtable.kill'))
              : null,
          }))
    }

    // ── tasks tab ───────────────────────────────────────────────────────────
    function TasksTab({ t }) {
      const [list, setList] = useState({ status: 'loading' })
      const [attempt, setAttempt] = useState(0)
      const [selectedId, setSelectedId] = useState('')
      const [outputAttempt, setOutputAttempt] = useState(0)
      const [killingId, setKillingId] = useState('')
      const [notice, setNotice] = useState(null)
      const output = useJobOutput(selectedId, outputAttempt)

      useEffect(() => {
        let live = true
        let timer = null
        const tick = () => {
          request('/tasks').then((page) => {
            if (!live) return
            setList({ status: 'ready', data: Array.isArray(page.tasks) ? page.tasks : [] })
            timer = setTimeout(tick, LIST_POLL_MS)
          }, (error) => {
            if (!live) return
            setList((previous) => previous.status === 'ready'
              ? { status: 'ready', data: previous.data, warning: error }
              : { status: 'error', error })
            timer = setTimeout(tick, LIST_POLL_MS)
          })
        }
        tick()
        return () => {
          live = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [attempt])

      async function killTask(id) {
        setKillingId(id)
        try {
          const data = await request('/tasks/kill', {
            method: 'POST',
            body: JSON.stringify({ id, reason: 'panel' }),
          })
          setNotice({
            tone: 'ok',
            text: t('tasks.killDone', { outcome: data.outcome === undefined ? t('unknown') : String(data.outcome) }),
          })
          setAttempt((value) => value + 1)
          setOutputAttempt((value) => value + 1)
        } catch (error) {
          setNotice({ tone: 'error', text: failureMessage(t, error), retry: () => { void killTask(id) } })
        } finally {
          setKillingId('')
        }
      }

      const tasks = list.status === 'ready' ? list.data.slice() : []
      tasks.sort((left, right) => {
        const leftActive = isActiveJob(left) ? 0 : 1
        const rightActive = isActiveJob(right) ? 0 : 1
        if (leftActive !== rightActive) return leftActive - rightActive
        return stampOf(right.startedAt) - stampOf(left.startedAt)
      })

      return h('div', { className: 'aall_stack' },
        h('section', { className: 'aall_section' },
          h('div', { className: 'aall_sectionHead' },
            h('h2', { className: 'aall_sectionTitle' }, t('tasks.list')),
            h('button', {
              type: 'button',
              className: 'aall_btn aall_btn-small',
              onClick: () => setAttempt((value) => value + 1),
            }, t('refresh')))),
        notice === null
          ? null
          : notice.retry !== undefined
            ? h(ErrorRow, { t, message: notice.text, onRetry: notice.retry })
            : h(Notice, { tone: notice.tone, text: notice.text }),
        list.status === 'loading' ? h(Loading, { t }) : null,
        list.status === 'error' ? h(ErrorRow, { t, message: failureMessage(t, list.error), onRetry: () => setAttempt((value) => value + 1) }) : null,
        list.status === 'ready' && list.warning !== undefined
          ? h(ErrorRow, { t, message: failureMessage(t, list.warning), onRetry: () => setAttempt((value) => value + 1) })
          : null,
        list.status === 'ready' && tasks.length === 0 ? h(Empty, { t, text: t('tasks.empty') }) : null,
        list.status === 'ready' && tasks.length > 0
          ? h('div', { className: 'aall_list' }, tasks.map((task, index) => {
            const record = task !== null && task !== undefined ? task : {}
            const id = record.id === undefined || record.id === null ? String(index) : String(record.id)
            const active = isActiveJob(record)
            return h('div', { key: id, className: 'aall_row' },
              h('span', { className: jobDotClass(record), 'aria-hidden': true }),
              h('div', { className: 'aall_rowMain' },
                h('div', { className: 'aall_rowTitle' },
                  h('span', { className: 'aall_rowName' }, record.label ? String(record.label) : id),
                  h('span', { className: 'aall_mono aall_dim' }, id)),
                h('div', { className: 'aall_rowSub' },
                  h('span', null, dictLabel(t, 'status.', record.status)),
                  record.progress ? h('span', { className: 'aall_dim' }, String(record.progress)) : null,
                  record.detail ? h('span', { className: 'aall_bad' }, String(record.detail)) : null,
                  h('span', { className: 'aall_dim' }, instantText(t, record.startedAt)))),
              h('div', { className: 'aall_rowEnd' },
                h('button', {
                  type: 'button',
                  className: 'aall_btn aall_btn-small',
                  onClick: () => setSelectedId(selectedId === id ? '' : id),
                }, selectedId === id ? t('tasks.hide') : t('tasks.view')),
                active
                  ? h('button', {
                    type: 'button',
                    className: 'aall_btn aall_btn-small aall_btn-danger',
                    disabled: killingId === id,
                    onClick: () => { void killTask(id) },
                  }, killingId === id ? t('tasks.killing') : t('tasks.kill'))
                  : null))
          }))
          : null,
        selectedId === ''
          ? null
          : h(OutputCard, {
            t,
            output,
            title: t('tasks.output'),
            emptyText: t('tasks.outputEmpty'),
            onRetry: () => setOutputAttempt((value) => value + 1),
          }))
    }

    // ── panel and sidebar icon ──────────────────────────────────────────────
    function Panel(props) {
      const t = props !== null && props !== undefined && typeof props.t === 'function' ? props.t : localize
      const [tab, setTab] = useState('state')
      const tabs = ['state', 'sessions', 'dispatch', 'roundtable', 'tasks']
      const body = tab === 'state'
        ? h(StateTab, { t })
        : tab === 'sessions'
          ? h(SessionsTab, { t })
          : tab === 'dispatch'
            ? h(DispatchTab, { t })
            : tab === 'roundtable' ? h(RoundtableTab, { t }) : h(TasksTab, { t })
      return h('div', { className: 'aall_page' },
        h('div', { className: 'aall_shell' },
          h('header', { className: 'aall_head' },
            h('h1', { className: 'aall_title' }, t('panel')),
            h('p', { className: 'aall_subtitle' }, t('subtitle')),
            h('p', { className: 'aall_warning' }, t('quotaWarning'))),
          h('div', { className: 'aall_tabs', role: 'tablist', 'aria-label': t('a11y.tabs') },
            tabs.map((name) => h('button', {
              key: name,
              type: 'button',
              role: 'tab',
              className: 'aall_tab',
              'aria-selected': tab === name ? 'true' : 'false',
              onClick: () => setTab(name),
            }, t('tab.' + name)))),
          h('div', { className: 'aall_body' }, body)))
    }

    function Icon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 64 64',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 3,
        strokeLinecap: 'round',
        'aria-hidden': true,
      },
        h('circle', { cx: 26, cy: 32, r: 15 }),
        h('circle', { cx: 38, cy: 32, r: 15 }),
        h('circle', { cx: 26, cy: 32, r: 3.5, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 38, cy: 32, r: 3.5, fill: 'currentColor', stroke: 'none' }))
    }

    // ── plugin object ───────────────────────────────────────────────────────
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'agent-alliance: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-agent-alliance')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'agent-alliance: styles')
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'agent-alliance',
        locale: NS,
      }, Panel))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'agent-alliance',
        order: 30,
        locale: NS,
        label: () => t('panel'),
      }, Icon))
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
