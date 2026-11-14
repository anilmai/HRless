# HRless

Adds an **HRless** button above the prompt box in Claude Code; the button opens the graph view of that session. Clicking it opens a local page (http://127.0.0.1:4777) that shows only that session's agent tree: the session at the top, the subagents it called below, and whatever those subagents called one level further down. If an agent ran `agy -p` or `codex exec`, the agy/Codex conversation it started appears under it too.

## Install

In the prompt box of a Claude Code session, in a terminal:

```
/plugin install hrless --marketplace anilmai/HRless
```

Answer `y` to `Add marketplace?`, then choose the scope (Enter, user scope).

From a shell:

```bash
claude plugin install hrless --marketplace anilmai/HRless
```

In the desktop app (when `/plugin` does not work): next to the prompt box, click + > Plugins > Add marketplace and add `anilmai/HRless`, then Add plugin.

Requires: Node.js 22.5 or newer on `PATH` (agy conversations are read with `node:sqlite`).

## Views

- **List:** each agent is a card with its status, last piece of work, project folder and model. Click a card to open its last prompt and the last 8 steps.
- **Graph** (icon at the top right): each agent is a coloured ball, with the orchestrator on top and the agents it started in tiers below. The mini list on the right shows which colour belongs to which agent type. Drag to pan, scroll to zoom, click a ball to open its details. Only agents that are working are drawn below the orchestrator; when an agent finishes it leaves the graph (the list view still shows it).
- **Story** (box on the left of the graph): tells the running work as sentences: who orchestrates, which agents it assigned, and who is waiting for whom.
- **Tokens** (box under the story): tokens burned by every agent in view, finished and hidden ones included: an "All" total first, then each tool (Claude, Codex, agy, custom agents) with the largest on top. Counted like Ponytail: input + output + cache reads + cache writes, as each tool records them; agy's count is read from its own files and is close, not exact. Each row also shows what those tokens cost in US dollars at the model's API list price (`server/prices.js`; cache reads and writes priced separately). That is an API-price equivalent, not what a subscription bills. A model without a known price shows "no price"; add one in `~/.hrless/config.json`, for example `{ "prices": { "gemini-3.8-flash": { "in": 0.3, "out": 2.5 } } }` (USD per 1M tokens; a key matches any model id that contains it).
- **This session · see all:** the page opened by the button shows only that session; this link switches to every session on the machine.
- Agents nothing in HRless started (a script that ran agy forty times, for example) are grouped per tool into one ball once there are three or more of them.

## Custom agents

The person icon in the toolbar opens **Your agents**. Add any agent HRless does not know yet, such as DeepSeek or Aider. Each agent has:

- **Name:** shown on its cards, in the filters and on the graph.
- **Colour:** the colour of its balls and tag.
- **Command:** the command that starts it, for example `deepseek`. When a Claude agent runs that command from Bash or PowerShell, the new conversation hangs under that Claude agent.
- **Session files:** a glob for the files the agent writes its conversations to, for example `~/.deepseek/sessions/**/*.jsonl`. JSON Lines files and JSON chat logs with role/content or OpenAI tool_calls are read. `~`, `*`, `?` and `**` work. Session files with OpenAI-style `usage` (prompt_tokens/completion_tokens/total_tokens) or Anthropic-style (input_tokens/output_tokens) fields are counted.

Settings are saved to `~/.hrless/config.json` (set `HRLESS_CONFIG` to use another path). Example:

```json
{ "agents": [ { "name": "DeepSeek", "color": "#4d6bfe", "cli": ["deepseek"], "logs": "~/.deepseek/sessions/**/*.jsonl" } ] }
```

An agent with no session files can report what it is doing itself. The endpoint accepts requests from localhost only, and only when they carry no foreign Origin:

```bash
curl -X POST http://127.0.0.1:4777/api/report -H "content-type: application/json" -d '{"agent":"DeepSeek","id":"run-1","parent":"<claude session or agent id>","title":"Fix login","state":"working","text":"reading auth.ts"}'
```

Fields: `agent` (required), `id`, `parent`, `title`, `prompt`, `text`, `kind` (`tool`, `say` or `prompt`), `model`, `cwd`, `state` (`working` or `done`), `tokens` (the run's total so far, a number).

## Where it reads from

| Tool | Files | Subagents |
| --- | --- | --- |
| Claude Code (CLI and desktop) | `~/.claude/projects/*/*.jsonl` | `<session>/subagents/agent-*.jsonl`, linked to the calling agent by `toolUseId` |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | by `parent_thread_id` |
| agy (Antigravity CLI) | `~/.gemini/antigravity-cli/conversations/*.db` | by `parent_references` |

agy and Codex conversations attach to the Claude agent that owned the `agy`/`codex` Bash call running when they started (matched by time; if several calls run at once, one can occasionally land on the wrong branch).

Status comes from the file's last write time: **working** within 90 seconds, **idle** within 30 minutes, and **done** when older. The page refreshes every 3 seconds. Nothing is sent anywhere: the server listens on `127.0.0.1` only and only reads files.

The page loads no fonts or scripts from the internet. It uses Montserrat and Geist if they are installed, otherwise the system font.

## Running it by hand

```bash
node server/server.js --open
```

The port changes with `HRLESS_PORT`. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are respected. After you change the server code, stop the running server, or the button will open the old one. The page (`index.html`) is read again on every request.

## License

MIT
