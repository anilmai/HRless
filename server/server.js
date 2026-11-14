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
const cliRe = names => new RegExp(`(^|[\\s;&|(])(${names.map(n => n.replace(/[.+]/g, '\\$&')).join('|')})(\\.exe|\\.cmd|\\.ps1)?(\\s+(?!--?(version|help)\\b)|$)`)

// Transcripts only grow, so each is read once and then only its new bytes (whole, not a tail:
// the Agent and Bash calls that tie agents together can be anywhere in it).
const scans = new Map()
function scanClaude(file) {
  const st = stat(file); if (!st) return null
  let c = scans.get(file)
  if (!c || st.size < c.pos) {
    c = { pos: 0, rest: '', d: { title: '', cwd: '', model: '', prompt: '', events: [], agentCalls: new Set(), bash: [], open: new Map(), start: 0 } }
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
    for (const b of m.content || []) {
      if (b.type === 'text' && b.text.trim()) push({ kind: 'say', text: clip(b.text) })
      if (b.type !== 'tool_use') continue
      push({ kind: 'tool', text: toolLine(b.name, b.input) })
      if (b.name === 'Agent' || b.name === 'Task') d.agentCalls.add(b.id)
      const cmd = b.input?.command
      if ((b.name === 'Bash' || b.name === 'PowerShell') && typeof cmd === 'string') {
        const call = { cmd: cmd.slice(0, 2000), start: ts, end: 0 }
        d.bash.push(call); d.open.set(b.id, call)
      }
    }
  }
}
function claudeNode(id, kind, d, title, mtime, done) {
  return { id, tool: 'claude', kind, title: title || clip(d.prompt, 80) || id.slice(0, 8), cwd: d.cwd, model: d.model,
    prompt: clip(d.prompt, 400), events: d.events, mtime, state: state(mtime, done), children: [], start: d.start, _d: d }
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
  for (const x of externals) {
    if (!x.cli?.length) { left.push(x); continue }
    const key = x.cli.join('|'); if (!res.has(key)) res.set(key, cliRe(x.cli))
    const re = res.get(key)
    let best = null, bestCall = null, gap = Infinity
    for (const [n, c] of calls) {
      if (!re.test(c.cmd)) continue
      // A call with no result yet is open only as long as its caller is still writing.
      const end = Math.max(c.end || n._d.mtime, c.start + 30000)
      if (x.start >= c.start - 3000 && x.start <= end + 3000) {
        const g = Math.abs(x.start - c.start); if (g < gap) { best = n; bestCall = c; gap = g }
      }
    }
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
  n.children.sort((x, y) => y.mtime - x.mtime)
  n.mtime = Math.max(n.mtime, ...n.children.map(c => c.mtime))
  delete n._d; delete n._call; delete n.start; delete n.cli; delete n._parent
  return n
}

// ---------- Codex ----------
function codexFiles(since) {
  const files = []
  const walk = (dir, depth) => {
    for (const e of ls(dir)) {
      const p = path.join(dir, e); const st = stat(p); if (!st) continue
      if (st.isDirectory()) { if (depth < 3 && st.mtimeMs >= since - 86400000) walk(p, depth + 1) }
      else if (e.endsWith('.jsonl') && st.mtimeMs >= since) files.push([p, st.mtimeMs])
    }
  }
  walk(path.join(CODEX, 'sessions'), 0)
  return files
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
  for (const [file, mtime] of codexFiles(since)) {
    const b = memo(file, mtime, () => {
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
      if (r.type === 'event_msg' && p.type === 'task_started') a.done = false
      if (r.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) a.done = true
      if (r.type !== 'response_item') continue
      if (p.type === 'message' && p.role === 'user') {
        const t = (p.content || []).map(c => c.text || '').join(' ')
        if (t && !/^\s*<(environment_context|user_instructions|permissions|collaboration)/.test(t)) { a.prompt = t; a.events.push({ t: r.timestamp, kind: 'prompt', text: clip(t) }) }
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
    if (!a.title) a.title = clip(a.prompt, 80) || id.slice(0, 8)
    a.prompt = clip(a.prompt, 400); a.events = a.events.slice(-8)
    return a
    })
    all.set(b.id, { ...b, children: [], state: state(b.mtime, b.done) })
  }
  const roots = []
  for (const a of all.values()) {
    const parent = a.parent && all.get(a.parent)
    if (parent) parent.children.push(a); else roots.push(a)
  }
  for (const a of all.values()) {
    a.children.sort((x, y) => y.mtime - x.mtime)
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
function agyHistory() {
  const map = new Map()
  for (const r of tailJson(path.join(AGY, 'history.jsonl'), 512 * 1024)) {
    if (!r.conversationId) continue
    const m = map.get(r.conversationId) || { workspace: r.workspace, prompts: [] }
    m.prompts.push({ t: r.timestamp, text: r.display }); map.set(r.conversationId, m)
  }
  return map
}
function collectAgy(since) {
  const out = []
  const dir = path.join(AGY, 'conversations')
  const hist = agyHistory()
  for (const f of ls(dir)) {
    if (!f.endsWith('.db')) continue
    const id = f.slice(0, -3)
    const mtime = Math.max(...[f, f + '-wal'].map(x => stat(path.join(dir, x))?.mtimeMs || 0))
    if (mtime < since) continue
    const h = hist.get(id)
    const b = memo(path.join(dir, f), mtime + ':' + (h?.prompts.length || 0), () => {
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
        const steps = db.prepare('select idx, step_type, step_payload from steps order by idx desc limit 40').all().reverse()
        for (const s of steps) {
          const r = runs(s.step_payload)
          // The typed prompt is the first readable run with a space; the long ones after it are injected instructions.
          if (s.step_type === 14) { const t = (r.find(x => /\s/.test(x)) || '').replace(/^\/\w+\s+/, ''); if (t) { if (!a.first) a.first = t; a.prompt = t; a.events.push({ kind: 'prompt', text: clip(t) }) } }
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
    a.title = clip(h?.prompts[0]?.text || a.first || a.prompt, 80) || id.slice(0, 8)
    a.prompt = clip(a.prompt, 400); a.events = a.events.slice(-8); delete a.first
    return a
    })
    out.push({ ...b, children: [], state: state(mtime) })
  }
  const byId = new Map(out.map(a => [a.id, a])); const roots = []
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
  const byId = new Map()
  for (const t of trees) for (const n of t.all) byId.set(n.id, n)
  for (const n of mine) byId.set(n.id, n)
  const loose = mine.filter(n => { const p = n._parent && byId.get(n._parent); if (p && p !== n) { p.children.push(n); return false } return true })
  const left = adoptCli(trees, [...safe(() => collectCodex(extSince)), ...safe(() => collectAgy(extSince)), ...loose])
  const roots = session ? trees.map(t => t.root) : [...trees.map(t => t.root), ...left]
  const agents = roots.map(settle).sort((x, y) => y.mtime - x.mtime)
  left.forEach(settle)
  return { now: Date.now(), hours, session: session || null, sources: custom.sources(), agents }
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
  if (u.pathname === '/api/ping') { res.writeHead(200); return res.end('hrless') }
  if (u.pathname === '/api/config' && req.method === 'GET') return json(res, 200, { path: custom.CONFIG, ...custom.loadConfig() })
  // Writes come from this page or from a local tool (curl, a hook); never from another website.
  if ((u.pathname === '/api/config' && req.method === 'PUT') || (u.pathname === '/api/report' && req.method === 'POST')) {
    if (!sameOrigin(req)) return json(res, 403, { error: 'forbidden' })
    return body(req).then(b => {
      try { json(res, 200, u.pathname === '/api/report' ? custom.report(b) : custom.saveConfig(b)) }
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
