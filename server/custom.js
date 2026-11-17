'use strict'
// Agents HRless does not know out of the box (DeepSeek, Aider, an in-house bot...). They add
// themselves by following HRLESS.md: a report over HTTP, or an entry in
// ~/.hrless/config.json (or HRLESS_CONFIG):
// { "agents": [ { "name": "DeepSeek", "color": "#4d6bfe", "cli": ["deepseek"],
//                 "logs": "~/.deepseek/sessions/**/*.jsonl" } ] }
//
// Each agent is shown under its own name and colour. Two ways in, either or both:
//  - `logs`: a glob of session files (JSON Lines, or JSON with a messages array). Each file is one
//    conversation; the reader understands the common chat shapes (role/content, OpenAI tool_calls).
//  - POST /api/report: the agent, a hook or a wrapper tells HRless what it is doing (HRLESS.md).
// `cli` names the command that starts the agent: a run of it from a Claude agent's Bash or
// PowerShell call hangs the new conversation under that Claude agent.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const HOME = os.homedir()
const CONFIG = process.env.HRLESS_CONFIG || path.join(HOME, '.hrless', 'config.json')
const BUILTIN = new Set(['claude', 'codex', 'agy'])

const stat = p => { try { return fs.statSync(p) } catch { return null } }
const clip = (s, n = 220) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent'
const COLOR = /^#[0-9a-f]{6}$/i
const CMD = /^[\w.+-]{1,40}$/

// ---------- config ----------
function clean(raw) {
  const agents = []
  const seen = new Set()
  for (const a of Array.isArray(raw?.agents) ? raw.agents.slice(0, 50) : []) {
    const name = clip(a?.name, 40)
    if (!name) continue
    let key = slug(name)
    if (BUILTIN.has(key)) key += '-custom'
    while (seen.has(key)) key += '-2'
    seen.add(key)
    agents.push({
      key, name,
      color: COLOR.test(a.color) ? a.color : null,
      cli: (Array.isArray(a.cli) ? a.cli : String(a.cli || '').split(/[,\s]+/)).filter(c => CMD.test(c)).slice(0, 5),
      logs: typeof a.logs === 'string' ? a.logs.trim().slice(0, 500) : '',
    })
  }
  // Optional USD prices per 1M tokens, keyed by a part of the model id (see prices.js).
  const prices = {}
  for (const [k, p] of Object.entries(raw?.prices && typeof raw.prices === 'object' ? raw.prices : {}).slice(0, 100)) {
    const num = v => (Number.isFinite(v) && v >= 0 && v < 10000 ? v : undefined)
    if (/^[\w.:-]{2,80}$/.test(k) && num(p?.in) !== undefined && num(p?.out) !== undefined)
      prices[k] = { in: p.in, out: p.out, cacheRead: num(p.cacheRead), cacheWrite: num(p.cacheWrite) }
  }
  return { agents, prices }
}
let cache = { mtime: -1, cfg: { agents: [] } }
function loadConfig() {
  const st = stat(CONFIG)
  if (!st) return { agents: [] }
  if (st.mtimeMs !== cache.mtime) {
    try { cache = { mtime: st.mtimeMs, cfg: clean(JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^﻿/, ''))) } } // Notepad and PowerShell 5 add a BOM
    catch { cache = { mtime: st.mtimeMs, cfg: { agents: [] } } }
  }
  return cache.cfg
}

// ---------- logs ----------
// A small glob: `~`, `*` and `?` within a name, `**` for any depth (up to 8 folders down).
function glob(pattern, since) {
  const p = pattern.replace(/^~(?=$|[\\/])/, HOME).replace(/\\/g, '/')
  const parts = p.split('/')
  const first = parts.findIndex(s => /[*?]/.test(s))
  if (first < 0) { const st = stat(p); return st && st.isFile() && st.mtimeMs >= since ? [[p, st]] : [] }
  const base = parts.slice(0, first).join('/') || '/'
  const rest = parts.slice(first)
  const re = new RegExp('^' + rest.map(s => s === '**' ? '(?:.*/)?' : s.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '/').join('').replace(/\(\?:\.\*\/\)\?$/, '.*').replace(/\/$/, '') + '$', 'i')
  const out = []
  let budget = 20000
  const walk = (dir, rel, depth) => {
    let names; try { names = fs.readdirSync(dir) } catch { return }
    for (const n of names) {
      if (--budget < 0 || out.length >= 300) return
      const full = dir + '/' + n, r = rel ? rel + '/' + n : n
      const st = stat(full); if (!st) continue
      if (st.isDirectory()) { if (depth < 8) walk(full, r, depth + 1) }
      else if (st.mtimeMs >= since && re.test(r)) out.push([full, st])
    }
  }
  walk(base.replace(/\/$/, ''), '', 0)
  return out
}

function text(c) {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(text).filter(Boolean).join(' ')
  if (typeof c === 'object') return c.text ?? c.content ?? c.value ?? ''
  return ''
}
// One record in any of the usual chat shapes.
function record(a, r) {
  if (!r || typeof r !== 'object') return
  const m = r.message && typeof r.message === 'object' ? r.message : r
  const role = String(m.role || r.role || r.type || r.event || '').toLowerCase()
  a.model = m.model || r.model || a.model
  a.title = r.title || r.summary || r.name && role === 'session' && r.name || a.title
  a.cwd = r.cwd || r.workdir || r.workspace || a.cwd
  a.parent = a.parent || r.parent_id || r.parentId || r.parent_session_id || r.parentSessionId || null
  // OpenAI-style usage (prompt/completion) or Anthropic-style (input/output) on a reply.
  const us = r.usage || m.usage
  if (us && typeof us === 'object') {
    const cached = us.prompt_tokens_details?.cached_tokens || 0
    a.use.in += us.input_tokens ?? Math.max(0, (us.prompt_tokens || 0) - cached)
    a.use.out += us.output_tokens ?? us.completion_tokens ?? 0
    a.use.cr += us.cache_read_input_tokens ?? cached
    a.use.cw += us.cache_creation_input_tokens || 0
  }
  if (/complete|finished|done|exit|end/.test(String(r.status || r.type || r.event || '').toLowerCase())) a.done = true
  const calls = m.tool_calls || r.tool_calls || (role.includes('tool') && (m.name || r.tool) ? [{ name: m.name || r.tool, arguments: m.arguments || r.input }] : [])
  for (const c of Array.isArray(calls) ? calls : []) {
    const name = c.function?.name || c.name || 'tool'
    let arg = c.function?.arguments ?? c.arguments ?? c.input ?? ''
    if (typeof arg === 'string') try { arg = JSON.parse(arg) } catch {}
    if (arg && typeof arg === 'object') arg = arg.command || arg.cmd || arg.path || arg.file_path || arg.query || arg.url || Object.values(arg)[0]
    a.events.push({ kind: 'tool', text: `${name}: ${clip(arg, 160)}` })
  }
  const t = text(m.content ?? r.content ?? r.text ?? r.prompt ?? r.output).trim()
  if (!t || role === 'system' || role.includes('tool')) return
  if (/user|human|input|prompt/.test(role)) { a.prompt = t; a.first = a.first || t; a.events.push({ kind: 'prompt', text: clip(t) }) }
  else a.events.push({ kind: 'say', text: clip(t) })
}
function readLog(file, st) {
  const a = { title: '', cwd: '', model: '', prompt: '', first: '', events: [], parent: null, done: false, use: { in: 0, out: 0, cr: 0, cw: 0 } }
  try {
    const size = Math.min(st.size, 4 * 1024 * 1024)
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, st.size - size); fs.closeSync(fd)
    const s = buf.toString('utf8')
    let whole = null
    if (size === st.size && /^\s*[[{]/.test(s)) try { whole = JSON.parse(s) } catch {}
    if (whole) {
      const msgs = Array.isArray(whole) ? whole : whole.messages || whole.history || whole.conversation || whole.turns
      if (Array.isArray(msgs)) {
        if (!Array.isArray(whole)) record(a, { ...whole, content: undefined, role: 'session' })
        for (const m of msgs) record(a, m)
      } else record(a, whole)
    } else {
      const lines = s.split('\n'); if (size < st.size) lines.shift()
      for (const l of lines) if (l.trim()) try { record(a, JSON.parse(l)) } catch {}
    }
  } catch {}
  a.events = a.events.slice(-8)
  return a
}

// ---------- reports pushed over HTTP ----------
const reports = new Map()
function report(body) {
  const cfg = loadConfig()
  const src = String(body?.agent || body?.source || '').trim()
  const known = cfg.agents.find(a => a.key === slug(src) || a.name.toLowerCase() === src.toLowerCase())
  const key = known ? known.key : slug(src)
  if (!src) throw new Error('agent is required')
  const id = clip(body.id || `${key}-${Date.now()}`, 120)
  const r = reports.get(id) || { id, key, name: known ? known.name : clip(src, 40), events: [], start: Date.now() }
  r.mtime = Date.now()
  if (body.title) r.title = clip(body.title, 120)
  if (body.parent) r.parent = clip(body.parent, 120)
  if (body.cwd) r.cwd = clip(body.cwd, 300)
  if (body.model) r.model = clip(body.model, 80)
  if (Number.isFinite(body.tokens) && body.tokens >= 0) r.tokens = Math.round(body.tokens) // the run's total so far
  if (body.prompt) { r.prompt = clip(body.prompt, 400); r.events.push({ kind: 'prompt', text: clip(body.prompt) }) }
  if (body.text) r.events.push({ kind: body.kind === 'tool' ? 'tool' : body.kind === 'prompt' ? 'prompt' : 'say', text: clip(body.text) })
  r.done = body.state === 'done' ? true : body.state === 'working' ? false : r.done
  // The command it was started with: a Claude agent's shell call to it then adopts it (see HRLESS.md).
  if (typeof body.command === 'string' && CMD.test(body.command)) r.cli = [body.command]
  r.events = r.events.slice(-8)
  reports.set(id, r)
  if (reports.size > 500) reports.delete(reports.keys().next().value)
  return { id }
}

// ---------- collect ----------
// Nodes for every custom agent active since `since`, as trees (a conversation's `parent` hangs it under another).
function collectCustom(since, state) {
  const cfg = loadConfig()
  const nodes = []
  for (const ag of cfg.agents) {
    if (!ag.logs) continue
    for (const [file, st] of glob(ag.logs, since)) {
      const a = readLog(file, st)
      const id = path.basename(file).replace(/\.[^.]+$/, '')
      nodes.push({ id: `${ag.key}:${id}`, tool: ag.key, kind: ag.name, title: clip(a.title || a.first || a.prompt, 80) || id.slice(0, 12),
        cwd: a.cwd, model: a.model, prompt: clip(a.prompt, 400), events: a.events, mtime: st.mtimeMs, state: state(st.mtimeMs, a.done),
        children: [], use: Object.values(a.use).some(v => v > 0) ? a.use : null, start: st.birthtimeMs || st.mtimeMs, cli: ag.cli, _parent: a.parent ? `${ag.key}:${a.parent}` : null })
    }
  }
  for (const r of reports.values()) {
    if (r.mtime < since) continue
    const ag = cfg.agents.find(a => a.key === r.key)
    nodes.push({ id: r.id, tool: r.key, kind: r.name, title: r.title || clip(r.prompt, 80) || r.id, cwd: r.cwd || '', model: r.model || '',
      prompt: r.prompt || '', events: r.events, mtime: r.mtime, state: state(r.mtime, r.done), children: [], tokens: r.tokens || 0, start: r.start,
      cli: r.cli || (ag ? ag.cli : []), _parent: r.parent || null })
  }
  return nodes
}

// What the page needs to name and colour each source.
function sources() {
  const out = { claude: { name: 'Claude' }, codex: { name: 'Codex' }, agy: { name: 'agy' } }
  for (const a of loadConfig().agents) out[a.key] = { name: a.name, color: a.color }
  for (const r of reports.values()) if (!out[r.key]) out[r.key] = { name: r.name }
  return out
}

module.exports = { CONFIG, loadConfig, report, collectCustom, sources }
