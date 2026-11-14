# HRless: instructions for AI agents

You are an AI agent (any tool, any model). A person watches their agents in HRless, a local
dashboard at `http://127.0.0.1:4777`. Claude Code, Codex and agy are tracked automatically.
If you are anything else, report yourself so you appear under your own name, model and colour.

## When to report

Send one report when you start a task, one whenever you move to a new step, and one when you
finish. If HRless is not running (the request fails or is refused), carry on with your work and
do not retry; reporting is optional and must never block or slow the task.

## How to report

`POST http://127.0.0.1:4777/api/report` with `content-type: application/json`:

```bash
curl -s -X POST http://127.0.0.1:4777/api/report -H "content-type: application/json" \
  -d '{"agent":"DeepSeek","model":"deepseek-v4","id":"run-2026-11-14-1","command":"deepseek","title":"Fix the login bug","state":"working","text":"reading src/auth.ts"}'
```

PowerShell:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:4777/api/report -ContentType 'application/json' -Body (@{ agent='DeepSeek'; model='deepseek-v4'; id='run-1'; command='deepseek'; title='Fix the login bug'; state='working'; text='reading src/auth.ts' } | ConvertTo-Json)
```

| Field | Meaning |
| --- | --- |
| `agent` | Required. Your tool's name, the same every time (for example `DeepSeek`, `Aider`). It becomes your row, filter and colour. |
| `model` | The model you run on, exactly as your provider names it (`deepseek-v4`). Used to show the model and price your tokens. |
| `id` | One id for this whole run, the same in every report of the run. Make it unique (a timestamp works). |
| `command` | The command you were started with (`deepseek`, `aider`). When a Claude agent started you from its shell, HRless hangs you under that agent. |
| `parent` | The id of the agent that started you, if you were told it. Takes priority over `command`. |
| `title` | The task in a few words. Send it in the first report. |
| `prompt` | The request you were given, if short. |
| `text` | What you are doing now, one line. |
| `kind` | `tool` when `text` is a tool call, `say` for a message, `prompt` for a new request. Default `say`. |
| `state` | `working` while you work, `done` in the last report. |
| `tokens` | Tokens used so far in this run, as one number, if you know it. |
| `cwd` | The folder you work in. |

Never put secrets, API keys or personal data in a report. Requests are accepted only from this
machine.

## If you write session logs

If your tool already saves each conversation as a JSON or JSON Lines file, HRless can read those
instead of reports. Add yourself to `~/.hrless/config.json` (create the file if it is missing; keep
any entries already in it):

```json
{ "agents": [ { "name": "DeepSeek", "color": "#4d6bfe", "cli": ["deepseek"], "logs": "~/.deepseek/sessions/**/*.jsonl" } ] }
```

To price a model HRless does not know, add `"prices": { "deepseek-v4": { "in": 0.27, "out": 1.1 } }`
to the same file (USD per 1M tokens). Use only a price you have checked.
