#!/usr/bin/env node
// HRless: one local page showing every Claude Code, Codex and agy (Antigravity CLI) agent
// on this machine, with their subagents, read live from the files each tool already writes.
// Usage: node server.js [--open]   ->  http://127.0.0.1:4777
'use strict'
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const custom = require('./custom')
const prices = require('./prices')
// Adds token usages ({ in, out, cr, cw }), skipping the empty ones.
const sumUse = list => list.reduce((s, u) => u ? { in: s.in + u.in, out: s.out + u.out, cr: s.cr + u.cr, cw: s.cw + u.cw } : s, { in: 0, out: 0, cr: 0, cw: 0 })

const PORT = Number(process.env.HRLESS_PORT || 4777)
const URL_ = `http://127.0.0.1:${PORT}`
const HOME = os.homedir()
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude')
const CODEX = process.env.CODEX_HOME || path.join(HOME, '.codex')
const AGY = path.join(HOME, '.gemini', 'antigravity-cli')

const ACTIVE_MS = 90 * 1000 // a file touched this recently = the agent is working
const IDLE_MS = 30 * 60 * 1000 // up to this = idle; older = finished

const stat = p => { try { return fs.statSync(p) } catch { return null } }
const ls = p => { try { return fs.readdirSync(p) } catch { return [] } }
const clip = (s, n = 220) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }

// Last `bytes` of a file, split into JSON records (the first, partial line is dropped).
function tailJson(file, bytes = 256 * 1024) {
  const st = stat(file); if (!st) return []
  const fd = fs.openSync(file, 'r')
  try {
    const start = Math.max(0, st.size - bytes)
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    const out = []
    for (const l of lines) { if (l.trim()) try { out.push(JSON.parse(l)) } catch {} }
    return out
  } finally { fs.closeSync(fd) }
}
function headText(file, bytes = 64 * 1024) {
  try { const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(bytes); const n = fs.readSync(fd, buf, 0, bytes, 0); fs.closeSync(fd); return buf.subarray(0, n).toString('utf8') }
  catch { return '' }
}
function headJson(file, bytes = 64 * 1024) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(bytes); const n = fs.readSync(fd, buf, 0, bytes, 0)
    const line = buf.subarray(0, n).toString('utf8').split('\n')[0]
    try { return JSON.parse(line) } catch { return null }
  } catch { return null } finally { fs.closeSync(fd) }
}

function state(mtime, done) {
  const age = Date.now() - mtime
  if (done) return age < ACTIVE_MS ? 'idle' : 'done'
  return age < ACTIVE_MS ? 'working' : age < IDLE_MS ? 'idle' : 'done'
}

// ---------- Claude Code ----------
function toolLine(name, input) {
  const i = input || {}
  const arg = i.description || i.command || i.file_path || i.pattern || i.prompt || i.url || i.query || i.skill || ''
  return `${name}${arg ? ': ' + clip(arg, 160) : ''}`
}
function claudeText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b.type === 'text').map(b => b.text).join(' ')
}
// A shell call that runs one of `names` (agy, codex, or a custom agent's command): not `--version`/`--help`.
// A path may lead to it only when it names the program file (…\agy\bin\agy.exe), not a folder
// called agy; a quote may close it ('…\agy.exe' -i …).
const cliRe = names => {
  const n = `(${names.map(n => n.replace(/[.+]/g, '\\$&')).join('|')})`
  return new RegExp(`(?:(^|[\\s;&|("'])${n}|[\\\\/]${n}(?=\\.(?:exe|cmd|ps1)\\b))(\\.exe|\\.cmd|\\.ps1)?["']?(\\s+(?!--?(version|help)\\b)|$)`)
}
// How much of `said` (from its start) `cmd` holds: the longer, the surer the match.
function quotedLength(cmd, said) {
  let lo = 0, hi = said.length
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cmd.includes(said.slice(0, m))) lo = m; else hi = m - 1 }
  return lo
}

// Transcripts only grow, so each is read once and then only its new bytes (whole, not a tail:
// the Agent and Bash calls that tie agents together can be anywhere in it).
const scans = new Map()
function scanClaude(file) {
  const st = stat(file); if (!st) return null
  let c = scans.get(file)
  if (!c || st.size < c.pos) {
    c = { pos: 0, rest: '', d: { title: '', cwd: '', model: '', prompt: '', events: [], agentCalls: new Set(), bash: [], open: new Map(), start: 0, usage: new Map() } }
    scans.set(file, c)
  }
  if (st.size > c.pos) {
    const fd = fs.openSync(file, 'r')
    try {
      while (c.pos < st.size) {
        const len = Math.min(8 * 1024 * 1024, st.size - c.pos)
        const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, c.pos); c.pos += len
        const lines = (c.rest + buf.toString('utf8')).split('\n'); c.rest = lines.pop()
        for (const l of lines) { if (l.trim()) try { claudeRecord(c.d, JSON.parse(l)) } catch {} }
      }
    } finally { fs.closeSync(fd) }
  }
  c.d.mtime = st.mtimeMs
  return c.d
}
function claudeRecord(d, r) {
  const ts = r.timestamp ? Date.parse(r.timestamp) : 0
  if (ts && !d.start) d.start = ts
  if (r.type === 'custom-title') d.title = r.customTitle
  if (r.type === 'ai-title' && !d.title) d.title = r.aiTitle || r.title
  if (r.cwd) d.cwd = r.cwd
  const m = r.message
  const push = e => { d.events.push(e); if (d.events.length > 8) d.events.shift() }
  if (r.type === 'user' && m) {
    const blocks = Array.isArray(m.content) ? m.content : []
    for (const b of blocks) if (b.type === 'tool_result' && d.open.has(b.tool_use_id)) { d.open.get(b.tool_use_id).end = ts; d.open.delete(b.tool_use_id) }
    const t = claudeText(m.content).trim()
    if (!r.isMeta && t && !blocks.some(b => b.type === 'tool_result') && !/^<(system-reminder|command|local-command|task-notification)/.test(t)) {
      d.prompt = t; push({ kind: 'prompt', text: clip(t) })
    }
  }
  if (r.type === 'assistant' && m) {
    if (m.model && m.model !== '<synthetic>') d.model = m.model
    // One reply can be written over several lines, each carrying the same usage: keyed by message id.
    const u = m.usage
    if (u && m.id) d.usage.set(m.id, { in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 })
    for (const b of m.content || []) {
      if (b.type === 'text' && b.text.trim()) push({ kind: 'say', text: clip(b.text) })
      if (b.type !== 'tool_use') continue
      push({ kind: 'tool', text: toolLine(b.name, b.input) })
      if (b.name === 'Agent' || b.name === 'Task') d.agentCalls.add(b.id)
      const cmd = b.input?.command
      // Terminal-pane calls start agents too; they return at once while the agent keeps running.
      const term = /^mcp__.*terminal__(run_in_terminal|open_terminal_tab)$/.test(b.name)
      if ((b.name === 'Bash' || b.name === 'PowerShell' || term) && typeof cmd === 'string') {
        const call = { cmd: cmd.slice(0, 2000), flat: cmd.slice(0, 2000).replace(/\s+/g, ' '), start: ts, end: 0, term }
        d.bash.push(call); d.open.set(b.id, call)
      }
    }
  }
}
function claudeNode(id, kind, d, title, mtime, done) {
  return { id, tool: 'claude', kind, title: title || clip(d.prompt, 80) || id.slice(0, 8), cwd: d.cwd, model: d.model,
    prompt: clip(d.prompt, 400), events: d.events, mtime, state: state(mtime, done), children: [], start: d.start, _d: d,
    use: sumUse([...d.usage.values()]) }
}
// One session as a tree: subagents hang under whoever called them (a subagent can call its own).
function claudeSession(dir, id, since) {
  const file = path.join(dir, id + '.jsonl'); const st = stat(file); if (!st) return null
  const subDir = path.join(dir, id, 'subagents')
  const subs = []
  for (const sf of ls(subDir)) {
    if (!sf.endsWith('.jsonl')) continue
    const sp = path.join(subDir, sf); const ss = stat(sp)
    if (!ss || ss.mtimeMs < since) continue
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(sp.replace(/\.jsonl$/, '.meta.json'), 'utf8')) } catch {}
    const n = claudeNode(sf.slice(0, -6), meta.agentType || 'subagent', scanClaude(sp), meta.description, ss.mtimeMs, meta.finished)
    n._call = meta.toolUseId
    subs.push(n)
  }
  const last = Math.max(st.mtimeMs, ...subs.map(s => s.mtime))
  if (last < since) return null
  const d = scanClaude(file)
  const root = claudeNode(id, 'session', d, d.title, st.mtimeMs)
  const all = [root, ...subs]
  for (const s of subs) (all.find(n => n !== s && n._d.agentCalls.has(s._call)) || root).children.push(s)
  return { root, all }
}
function collectClaude(since, only) {
  const out = []
  const projects = path.join(CLAUDE, 'projects')
  for (const proj of ls(projects)) {
    const dir = path.join(projects, proj)
    for (const f of ls(dir)) {
      if (!f.endsWith('.jsonl') || (only && f !== only + '.jsonl')) continue
      const t = claudeSession(dir, f.slice(0, -6), only ? 0 : since)
      if (t) out.push(t)
    }
  }
  return out
}

// Hang each outside agent (agy, Codex, custom) under the Claude agent whose shell call to its
// command (`agy -p`, `codex exec`, `deepseek ...`) was running when it was born.
function adoptCli(trees, externals) {
  const calls = []
  for (const t of trees) for (const n of t.all) for (const c of n._d.bash) calls.push([n, c])
  const res = new Map()
  const left = []
  // A call that has adopted an agent yields to a free one, so twenty agents started in the same
  // second land under their twenty callers, not all under the first; it is still taken when no
  // free call fits, as a single call that starts agents in a loop (`for id in …; do agy -p … & done`).
  const used = new Set()
  for (const x of [...externals].sort((a, b) => a.start - b.start)) {
    if (!x.cli?.length) { left.push(x); continue }
    const key = x.cli.join('|'); if (!res.has(key)) res.set(key, cliRe(x.cli))
    const re = res.get(key)
    // The agent's own prompt quoted in the command line is the surest match.
    // Up to 300 characters: briefs often share their first sentence and differ only in the section they name.
    const said = (x.ask || x.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    let best = null, bestCall = null, gap = Infinity
    for (const [n, c] of calls) {
      if (!re.test(c.cmd)) continue
      // A call with no result yet is open only as long as its caller is still writing.
      // A terminal call returns at once and its agent may open minutes later; the agent's own
      // prompt quoted in the command still ties them within 10 minutes, the longest quote winning.
      const k = said.length > 6 ? quotedLength(c.flat || c.cmd, said) : 0
      const quoted = k > 6 && k >= Math.min(40, said.length)
      const end = quoted ? c.start + 600000 : Math.max(c.term ? c.start + 180000 : c.end || n._d.mtime, c.start + 30000)
      if (x.start >= c.start - 3000 && x.start <= end + 3000) {
        const g = (quoted ? -k : Math.abs(x.start - c.start)) + (used.has(c) ? 1e12 : 0)
        if (g < gap) { best = n; bestCall = c; gap = g }
      }
    }
    if (bestCall) used.add(bestCall)
    // The command names the model (`agy -p ... --model gemini-3.8-flash-high`) when the agent's own files do not.
    const mm = bestCall && bestCall.cmd.match(/(?:--model|-m)[\s=]+["']?([\w.:\-]+)/)
    if (mm && (!x.model || x.model === 'gemini')) x.model = mm[1]
    if (best) best.children.push(x); else left.push(x)
  }
  return left
}
// mtime and "working" rise from the leaves, so a busy grandchild lights its whole branch.
function settle(n) {
  for (const c of n.children) settle(c)
  n.children.sort((x, y) => (x.start || 0) - (y.start || 0)) // in the order they were started: a busy one does not jump
  n.mtime = Math.max(n.mtime, ...n.children.map(c => c.mtime))
  // Tokens of all four kinds, and their price at API rates (null: unknown).
  if (n.use) n.tokens = n.use.in + n.use.out + n.use.cr + n.use.cw
  else n.tokens = n.tokens || 0
  n.cost = n.use ? prices.cost(n.model, n.use, custom.loadConfig().prices) : null
  delete n._d; delete n._call; delete n.cli; delete n._parent
  return n
}

// ---------- Codex ----------
function codexFiles(since) {
  const files = []
  // sessions/YYYY/MM/DD: a folder's own mtime only moves when a child is added, so the
  // folder's date (its name) decides; a run may keep writing for days, hence the 3-day margin.
  const walk = (dir, depth, ymd) => {
    for (const e of ls(dir)) {
      const p = path.join(dir, e); const st = stat(p); if (!st) continue
      if (st.isDirectory()) {
        if (depth >= 3) continue
        const parts = [...ymd, Number(e)]
        if (parts.every(Number.isFinite)) {
          const [y, m = 12, d] = parts
          const end = depth === 0 ? Date.UTC(y + 1, 0, 1) : depth === 1 ? Date.UTC(y, m, 1) : Date.UTC(y, m - 1, d + 1)
          if (end < since - 3 * 86400000) continue
        }
        walk(p, depth + 1, parts)
      } else if (e.endsWith('.jsonl')) { const t = lastWrite(p, st); if (t >= since) files.push([p, t, st.size]) }
    }
  }
  walk(path.join(CODEX, 'sessions'), 0, [])
  return files
}
// Windows does not move a file's mtime while a process keeps it open and appends (Codex does),
// so a file that grew since the last poll counts as written now.
const growth = new Map()
function lastWrite(file, st) {
  const g = growth.get(file)
  if (!g || g.size !== st.size) { growth.set(file, { size: st.size, at: g ? Date.now() : st.mtimeMs }); return g ? Date.now() : st.mtimeMs }
  return Math.max(g.at, st.mtimeMs)
}
// A parsed agy or Codex file is kept until the file changes: polling every 3 s then costs a stat, not a parse.
const memoMap = new Map()
function memo(key, ver, fn) {
  const c = memoMap.get(key)
  if (c && c.ver === ver) return c.v
  const v = fn(); memoMap.set(key, { ver, v }); return v
}
function collectCodex(since) {
  const all = new Map()
  for (const [file, mtime, size] of codexFiles(since)) {
    // Keyed by size too: the mtime alone may not move while Codex writes.
    const b = memo(file, size, () => {
    const head = headJson(file)?.payload || {}
    const id = head.id || head.session_id || path.basename(file)
    const spawnInfo = head.source?.subagent?.thread_spawn
    const a = { cli: ['codex'], start: Date.parse(head.timestamp || '') || mtime, id, tool: 'codex', kind: spawnInfo ? (spawnInfo.agent_role || 'subagent') : head.thread_source === 'guardian_review' ? 'guardian' : 'thread',
      title: spawnInfo?.agent_nickname ? `${spawnInfo.agent_nickname} · ${spawnInfo.agent_path || ''}` : '', cwd: head.cwd || '', model: '',
      prompt: '', events: [], mtime, parent: spawnInfo?.parent_thread_id || head.parent_thread_id || null, children: [], done: false }
    for (const r of tailJson(file)) {
      const p = r.payload || {}
      if (r.type === 'turn_context' && p.model) a.model = p.model
      if (p.model && typeof p.model === 'string') a.model = p.model
      if (p.thread_settings?.model) a.model = p.thread_settings.model
      if (r.type === 'event_msg' && p.type === 'task_started') a.done = false
      // Codex reports a running total for the thread.
      // input_tokens includes the cached part; output_tokens includes reasoning.
      const tu = r.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage
      if (tu) a.use = { in: (tu.input_tokens || 0) - (tu.cached_input_tokens || 0), out: tu.output_tokens || 0, cr: tu.cached_input_tokens || 0, cw: tu.cache_write_input_tokens || 0 }
      if (r.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) a.done = true
      if (r.type !== 'response_item') continue
      if (p.type === 'message' && p.role === 'user') {
        const t = (p.content || []).map(c => c.text || '').join(' ')
        // Skip what Codex injects as a user message (environment, AGENTS.md); keep what was asked.
        if (t && !/^\s*(<(environment_context|user_instructions|permissions|collaboration)|# AGENTS\.md instructions)/.test(t)) { a.prompt = t; a.events.push({ t: r.timestamp, kind: 'prompt', text: clip(t) }) }
      }
      if (p.type === 'message' && p.role === 'assistant') {
        const t = (p.content || []).map(c => c.text || '').join(' ')
        if (t.trim()) a.events.push({ t: r.timestamp, kind: 'say', text: clip(t) })
      }
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        let arg = p.input || p.arguments || ''
        try { const j = JSON.parse(arg); arg = j.cmd || j.command || j.path || j.description || arg } catch {}
        a.events.push({ t: r.timestamp, kind: 'tool', text: `${p.name || p.type}: ${clip(Array.isArray(arg) ? arg.join(' ') : arg, 160)}` })
      }
    }
    // The model is set once near the start, which a long thread's tail no longer holds.
    // Newer Codex writes it as "model":{"model":…} or under collaboration_mode, past the first 64 KB.
    if (!a.model) { const m = headText(file, 512 * 1024).match(/"thread_settings":\{"model":"([^"]+)"|"model":\{"model":"([^"]+)"|"collaboration_mode":\{"mode":"[^"]*","model":"([^"]+)"/); if (m) a.model = m[1] || m[2] || m[3] }
    if (!a.title) a.title = clip(a.prompt, 80) || id.slice(0, 8)
    a.prompt = clip(a.prompt, 400); a.events = a.events.slice(-8)
    return a
    })
    all.set(b.id, { ...b, mtime, children: [], state: state(mtime, b.done) })
  }
  const roots = []
  for (const a of all.values()) {
    const parent = a.parent && all.get(a.parent)
    if (parent) parent.children.push(a); else roots.push(a)
  }
  for (const a of all.values()) {
    a.children.sort((x, y) => (x.start || 0) - (y.start || 0))
    a.mtime = Math.max(a.mtime, ...a.children.map(c => c.mtime))
    if (a.children.some(c => c.state === 'working')) a.state = 'working'
  }
  return roots
}

// ---------- agy (Antigravity CLI) ----------
let sqlite = null
try { sqlite = require('node:sqlite') } catch {}
// Step payloads are protobuf; the readable runs inside are enough to say what it did.
const runs = buf => Buffer.from(buf || []).toString('utf8').split(/[\x00-\x1f�]+/).map(s => s.trim()).filter(s => s.length > 2)
// A step's metadata is protobuf holding its timestamps (seconds as varints): the latest plausible one, in ms.
function stepTime(buf) {
  const b = Buffer.from(buf || []), max = Date.now() / 1000 + 86400
  let best = 0
  for (let i = 0; i < b.length; i++) {
    let v = 0, sh = 0
    for (let j = i; j < b.length && j < i + 6; j++) { v += (b[j] & 127) * 2 ** sh; sh += 7; if (!(b[j] & 128)) break }
    if (v > 1.7e9 && v < max && v > best) best = v
  }
  return best * 1000
}
// A generation's metadata (protobuf) holds its usage at field 1.4: 1 input, 2 and 3 output and
// thinking, 5 cache reads. agy publishes no schema, so this is a close count read from its files.
function pbFields(b) {
  const out = new Map(); let i = 0
  const vint = () => { let v = 0, s = 0, x; do { x = b[i++]; v += (x & 127) * 2 ** s; s += 7 } while (x & 128 && i < b.length); return v }
  while (i < b.length) {
    const k = vint(), f = Math.floor(k / 8), w = k & 7
    if (w === 0) out.set(f, vint())
    else if (w === 2) { const l = vint(); out.set(f, b.subarray(i, i + l)); i += l }
    else if (w === 1) i += 8; else if (w === 5) i += 4; else break
  }
  return out
}
function genTokens(buf) {
  try {
    const one = pbFields(Buffer.from(buf || [])).get(1)
    const use = one && typeof one !== 'number' && pbFields(one).get(4)
    if (!use || typeof use === 'number') return null
    const u = pbFields(use), n = k => typeof u.get(k) === 'number' ? u.get(k) : 0
    return { in: n(1), out: n(2) + n(3), cr: n(5), cw: 0 }
  } catch { return null }
}
// The model a generation asked for (field 3.28, e.g. gemini-4-hydrogen-medium), else the one that served it (1.19).
function genModel(buf) {
  try {
    const top = pbFields(Buffer.from(buf || []))
    for (const [a, b] of [[3, 28], [1, 19]]) {
      const m = top.get(a); const v = m && typeof m !== 'number' && pbFields(m).get(b)
      if (v && typeof v !== 'number') { const id = Buffer.from(v).toString('utf8'); if (/^[\w.-]{3,80}$/.test(id)) return id }
    }
  } catch {}
  return null
}
function agyHistory() {
  const map = new Map()
  for (const r of tailJson(path.join(AGY, 'history.jsonl'), 512 * 1024)) {
    if (!r.conversationId) continue
    const m = map.get(r.conversationId) || { workspace: r.workspace, prompts: [] }
    m.prompts.push({ t: r.timestamp, text: r.display }); map.set(r.conversationId, m)
  }
  return map
}
// The typed prompt in a user step: the first readable run with a space (the long ones after it are injected
// instructions). The run starts with a protobuf length byte that may read as a character, then a mode command (`/plan`).
const agyPrompt = payload => (runs(payload).find(x => /\s/.test(x)) || '').replace(/^[^\w/(<]*(\/\w+\s+)?/, '').replace(/^<USER_REQUEST>\s*/, '')
// Subagents a conversation created: agy writes them only to its own transcript log, read here in the
// bytes added since the last poll (a parent's log can be many MB and grows while it waits on a child).
const SUB_RE = /Created the following subagent:(?:\\n|\s)*\{(?:\\n|\s)*\\?"conversationId\\?":\s*\\?"([0-9a-f-]{36})/g
const subLogs = new Map()
function agySubs(id) {
  const file = path.join(AGY, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
  const st = stat(file); if (!st) return []
  let c = subLogs.get(file)
  if (!c || st.size < c.pos) { c = { pos: 0, rest: '', subs: [], mtime: 0 }; subLogs.set(file, c) }
  c.mtime = st.mtimeMs
  if (st.size > c.pos) {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(st.size - c.pos); fs.readSync(fd, buf, 0, buf.length, c.pos)
      const text = c.rest + buf.toString('latin1'), cut = text.lastIndexOf('\n') + 1
      for (const m of text.slice(0, cut).matchAll(SUB_RE)) c.subs.push(m[1])
      c.rest = text.slice(cut); c.pos = st.size
    } finally { fs.closeSync(fd) }
  }
  return c.subs
}
function agyNode(dir, f, hist) {
  const id = f.slice(0, -3)
  const mtime = Math.max(...[f, f + '-wal'].map(x => stat(path.join(dir, x))?.mtimeMs || 0))
  const h = hist.get(id)
  const size = [f, f + '-wal'].map(x => stat(path.join(dir, x))?.size || 0).join('+') // see lastWrite
  const b = memo(path.join(dir, f), mtime + ':' + size + ':' + (h?.prompts.length || 0), () => {
    const a = { cli: ['agy'], start: stat(path.join(dir, f))?.birthtimeMs || mtime, id, tool: 'agy', kind: 'conversation', title: '', cwd: h?.workspace || '', model: 'gemini', prompt: '', events: [], mtime, children: [], parent: null }
    if (sqlite) {
      let db
      try {
        db = new sqlite.DatabaseSync(path.join(dir, f), { readOnly: true })
        const meta = db.prepare('select data from trajectory_metadata_blob').get()
        const ws = meta && runs(meta.data).join(' ').match(/file:\/\/\/([^\s|"$]+?)(?=\$|z\b|\s|$)/)
        if (ws && !a.cwd) a.cwd = decodeURIComponent(ws[1])
        const parentRef = db.prepare('select data from parent_references limit 1').get()
        if (parentRef) { const m = runs(parentRef.data).join(' ').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/); if (m && m[0] !== id) a.parent = m[0] }
        const gens = db.prepare('select data from gen_metadata').all()
        a.use = sumUse(gens.map(g => genTokens(g.data)))
        if (gens.length) a.model = genModel(gens[gens.length - 1].data) || a.model
        // The first prompt: a long conversation's last 40 steps no longer hold it.
        const first = db.prepare('select step_payload from steps where step_type = 14 order by idx limit 1').get()
        if (first) a.ask = agyPrompt(first.step_payload)
        const steps = db.prepare('select idx, step_type, step_payload, metadata from steps order by idx desc limit 40').all().reverse()
        for (const s of steps) {
          const t = stepTime(s.metadata); if (t > (a.real || 0)) a.real = t
          const r = runs(s.step_payload)
          if (s.step_type === 14) { const t = agyPrompt(s.step_payload); if (t) { if (!a.first) a.first = t; a.prompt = t; a.events.push({ kind: 'prompt', text: clip(t) }) } }
          else if (s.step_type === 132) {
            const i = r.findIndex(x => /^call_\d+/.test(x)); const name = i >= 0 ? r[i + 1] : 'tool'
            const args = (r.find(x => x.includes('{"')) || '').replace(/^[^{]*/, '')
            let arg = args; try { const j = JSON.parse(args.replace(/[^}]*$/, '')); arg = j.CommandLine || j.Path || j.AbsolutePath || j.Query || j.Url || Object.values(j)[0] } catch {}
            a.events.push({ kind: 'tool', text: `${name}: ${clip(arg, 160)}` })
          } else if (s.step_type === 15) {
            const t = r.filter(x => x.length > 40 && !/^\(bot-|sessionID/.test(x) && /\s/.test(x)).sort((x, y) => y.length - x.length)[0]
            if (t) a.events.push({ kind: 'say', text: clip(t) })
          }
        }
      } catch {} finally { try { db?.close() } catch {} }
    }
    if (h?.prompts.length) a.prompt = h.prompts[h.prompts.length - 1].text
    a.title = clip(h?.prompts[0]?.text || a.ask || a.first || a.prompt, 80) || id.slice(0, 8)
    a.prompt = clip(a.prompt, 400); a.events = a.events.slice(-8); delete a.first
    return a
  })
  // agy rewrites every conversation file when it starts, so a file's time says nothing:
  // the last step's own time does (or, for one with no step yet, when it was created).
  const t = b.real || b.start || mtime
  return { ...b, mtime: t, children: [], state: state(t) }
}
function collectAgy(since) {
  const dir = path.join(AGY, 'conversations')
  const hist = agyHistory()
  const files = ls(dir).filter(f => f.endsWith('.db'))
  const out = []
  for (const f of files) {
    if (Math.max(...[f, f + '-wal'].map(x => stat(path.join(dir, x))?.mtimeMs || 0)) < since) continue
    const a = agyNode(dir, f, hist)
    if (a.mtime >= since) out.push(a)
  }
  const byId = new Map(out.map(a => [a.id, a]))
  // A child starts after its parent: no loops.
  const adopt = (a, s) => { const k = byId.get(s); if (k && !k.parent && k !== a && k.start >= a.start) k.parent = a.id }
  for (const a of out) for (const s of agySubs(a.id)) adopt(a, s)
  // A working child whose parent went quiet before the window: find that parent among the logs
  // written since the child started, and show it too.
  const orphans = out.filter(a => !a.parent)
  if (orphans.length) {
    const from = Math.min(...orphans.map(a => a.start)), want = new Set(orphans.map(a => a.id))
    for (const f of files) {
      const id = f.slice(0, -3); if (byId.has(id)) continue
      const log = stat(path.join(AGY, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'))
      if (!log || log.mtimeMs < from) continue
      const subs = agySubs(id).filter(s => want.has(s)); if (!subs.length) continue
      const p = agyNode(dir, f, hist); byId.set(id, p); out.push(p)
      for (const s of subs) adopt(p, s)
    }
  }
  const roots = []
  for (const a of out) { const p = a.parent && byId.get(a.parent); if (p) p.children.push(a); else roots.push(a) }
  return roots
}

// The whole picture, or with `session` only the one Claude session the HRless button was pressed in,
// with everything it started: subagents, their subagents, and the agy/Codex agents any of them ran.
function snapshot(hours, session) {
  const since = Date.now() - hours * 3600 * 1000
  const safe = fn => { try { return fn() } catch (e) { console.error(e); return [] } }
  // agy and Codex agents are looked up over a week, so one started long ago by this session still finds its parent.
  const extSince = session ? Date.now() - 7 * 86400000 : since
  const trees = safe(() => collectClaude(since, session))
  // Custom agents first find a parent they name themselves (another of theirs, or any agent's id).
  const mine = safe(() => custom.collectCustom(extSince, state))
  const external = [...safe(() => collectCodex(extSince)), ...safe(() => collectAgy(extSince))]
  const byId = new Map()
  const index = n => { byId.set(n.id, n); n.children.forEach(index) }
  external.forEach(index)
  for (const t of trees) for (const n of t.all) byId.set(n.id, n)
  for (const n of mine) byId.set(n.id, n)
  const loose = mine.filter(n => {
    const parent = byId.get(n._parent)
    if (!parent) return true
    const seen = new Set([n])
    for (let p = parent; p; p = byId.get(p._parent)) {
      if (seen.has(p)) return true
      seen.add(p)
    }
    parent.children.push(n)
    return false
  })
  const left = adoptCli(trees, [...external, ...loose])
  const roots = session ? [byId.get(session)].filter(Boolean) : [...trees.map(t => t.root), ...left]
  // Fixed order, newest-started first; a tree that has gone quiet for good (done all through) sinks below
  // the live ones, so working sessions stay on top without jumping each time one of them answers.
  const live = n => n.state !== 'done' || n.children.some(live)
  const agents = roots.map(settle).sort((x, y) => live(y) - live(x) || (y.start || y.mtime) - (x.start || x.mtime))
  return { now: Date.now(), hours, session: session || null, sources: custom.sources(), agents, limits: safe(limits) }
}

// Plan limits (5-hour and weekly windows), as { tool: { at, windows: [{ kind: '5h'|'week', pct, resets }] } }.
// Claude: written by the HRless mod from Claude Code's own rate-limit reading (hooks/register.tsx).
// Codex: the last rate_limits its newest rollout file recorded. agy keeps its quota in memory only.
const LIMITS_FILE = path.join(HOME, '.hrless', 'limits.json')
function limits() {
  const out = {}
  try { const c = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')).claude; if (c?.windows) out.claude = c } catch {}
  const newest = codexFiles(Date.now() - 8 * 86400000).sort((a, b) => b[1] - a[1])
  for (const [file, t, size] of newest.slice(0, 5)) {
    const rl = memo('rl:' + file, size, () => {
      const recs = tailJson(file)
      for (let i = recs.length - 1; i >= 0; i--) { const r = recs[i].payload?.rate_limits; if (r?.primary || r?.secondary) return r }
      return null
    })
    if (!rl) continue
    const win = w => w && { kind: w.window_minutes <= 300 ? '5h' : 'week', pct: w.used_percent, resets: w.resets_at * 1000 }
    out.codex = { at: t, windows: [win(rl.primary), win(rl.secondary)].filter(Boolean) }
    break
  }
  refreshAgyQuota()
  if (agyQuota) out.agy = agyQuota
  return out
}
// agy: `agy -p /usage` answers its quota without a model turn (0 tokens, no conversation).
// Asked at most every 5 minutes, in the background, while the page is open.
let agyQuota = null, agyAskedAt = 0
function refreshAgyQuota() {
  if (Date.now() - agyAskedAt < 5 * 60000) return
  agyAskedAt = Date.now()
  let p
  try { p = spawn('agy', ['-p', '/usage', '--output-format', 'json'], { cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return }
  let s = ''
  p.on('error', () => {})
  p.stdout.on('data', d => { if (s.length < 1e6) s += d })
  const kill = setTimeout(() => p.kill(), 90000)
  p.on('close', () => {
    clearTimeout(kill)
    try {
      const r = JSON.parse(s)
      // An agy too old to answer /usage itself treats it as a prompt and runs a real (paid) turn: never ask it again.
      if (r.num_turns > 0 || r.usage?.total_tokens > 0 || !r.command) { agyAskedAt = Infinity; return }
      const groups = r.command.data?.groups || []
      const windows = groups.flatMap(g => (g.buckets || []).filter(b => b.window === '5h' || b.window === 'weekly').map(b => ({
        kind: b.window === '5h' ? '5h' : 'week', group: g.name, pct: Math.round((1 - b.remaining_fraction) * 1000) / 10, resets: Date.parse(b.reset_time) || null })))
      if (windows.length) agyQuota = { at: Date.now(), windows }
    } catch { if (s.trim()) agyAskedAt = Infinity } // it answered, but not in a shape we know: stop asking too
  })
}

// --session <id>: open on that Claude session's own tree.
const argSession = (process.argv[process.argv.indexOf('--session') + 1] || '').replace(/[^\w-]/g, '')
function openBrowser() {
  const url = process.argv.includes('--session') && argSession ? `${URL_}/?session=${argSession}` : URL_
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref()
}

// Read per request, so an edited page shows on refresh without restarting the server.
const page = () => fs.readFileSync(path.join(__dirname, 'index.html'))
const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)) }
// JSON bodies only (a cross-site form cannot send one without a preflight we never answer), 64 KB at most.
function body(req) {
  return new Promise((ok, fail) => {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return fail(new Error('content-type must be application/json'))
    let s = ''
    req.on('data', d => { s += d; if (s.length > 65536) { fail(new Error('too large')); req.destroy() } })
    req.on('end', () => { try { ok(JSON.parse(s || '{}')) } catch { fail(new Error('invalid JSON')) } })
  })
}
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`])
const sameOrigin = req => !req.headers.origin || HOSTS.has(req.headers.origin.replace(/^https?:\/\//, ''))
const server = http.createServer((req, res) => {
  // A page on another site that rebinds its name to 127.0.0.1 still sends its own Host: refuse it.
  if (!HOSTS.has(req.headers.host || '')) { res.writeHead(403); return res.end() }
  const u = new URL(req.url, URL_)
  if (u.pathname === '/api/agents') {
    const hours = Math.min(168, Math.max(0.1, Number(u.searchParams.get('hours')) || 24))
    const session = /^[\w-]{8,64}$/.test(u.searchParams.get('session') || '') ? u.searchParams.get('session') : null
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(JSON.stringify(snapshot(hours, session)))
  }
  // The token card's own range (24 h … all): only what it sums, so a long range stays a small answer.
  if (u.pathname === '/api/tokens') {
    const hours = Math.max(0.1, Number(u.searchParams.get('hours')) || 24)
    const slim = a => ({ tool: a.tool, kind: a.kind, tokens: a.tokens, cost: a.cost, children: a.children.map(slim) })
    return json(res, 200, snapshot(hours).agents.map(slim))
  }
  if (u.pathname === '/api/ping') { res.writeHead(200); return res.end('hrless') }
  // Agents report themselves here (HRLESS.md): from a local tool, never from another website.
  if (u.pathname === '/api/report' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'forbidden' })
    return body(req).then(b => {
      try { json(res, 200, custom.report(b)) }
      catch (e) { json(res, 400, { error: String(e.message || e) }) }
    }, e => json(res, 400, { error: String(e.message || e) }))
  }
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page()) }
  res.writeHead(404); res.end()
})
server.on('error', e => {
  // Already running (another session pressed the button first): just open the page.
  if (e.code === 'EADDRINUSE') { if (process.argv.includes('--open')) openBrowser(); setTimeout(() => process.exit(0), 300) }
  else { console.error(e); process.exit(1) }
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`HRless ${URL_}`)
  if (process.argv.includes('--open')) openBrowser()
})
