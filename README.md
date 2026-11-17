# HRless

A local dashboard for the AI agents running on your machine. HRless shows every Claude Code, Codex and agy (Antigravity CLI) agent, the subagents each one started, what they are doing now and how many tokens they have used.

It adds an **HRless** button above the prompt box in Claude Code. The button opens http://127.0.0.1:4777 on that session's agent tree: the session on top, the subagents it called below it, and any agy or Codex conversation an agent started with `agy -p` or `codex exec`.

## Install

In a Claude Code session:

```
/plugin install hrless --marketplace anilmai/HRless
```

Answer `y` to `Add marketplace?`, then choose the scope (Enter for user scope).

From a shell:

```bash
claude plugin install hrless --marketplace anilmai/HRless
```

In the desktop app: next to the prompt box, click **+ > Plugins > Add marketplace**, add `anilmai/HRless`, then **Add plugin**.

Requires Node.js 22.5 or newer on `PATH` (agy conversations are read with `node:sqlite`).

## Views

- **List:** one card per agent with its status, latest step, project folder and model. Click a card for its last prompt and last 8 steps.
- **Graph:** each agent is a ball, with the orchestrator on top and the agents it started in tiers below. Only working agents are drawn under the orchestrator; finished ones stay in the list view. Drag to pan, scroll to zoom, click a ball for details.
- **Story:** the current work in a few lines: the session, its status, the agents it assigned and its latest step.
- **Tokens:** tokens used per tool (Claude, Codex, agy, custom agents), with tabs for 24 h, 7 d, 30 d, 90 d and all time. In a single-session view the first tab counts that session only. A session that worked within the range counts in full.
- **Plan limits:** each tool's 5-hour and weekly limit, how much is used and when it resets. Claude's comes from Claude Code itself (it fills in after the first reply once the plugin is installed), Codex's from its session files, and agy's from `agy -p /usage`, asked every 5 minutes; that needs `agy` on `PATH` and signed in. An agy too old to answer `/usage` without a model turn is asked once and then left alone.
- **This session · see all:** the page opened by the button shows one session; this link switches to every session on the machine.

Agents not started by a tracked agent (a script that ran agy forty times, for example) are grouped per tool once there are three or more.

### Token counts and cost

Tokens are input + output + cache reads + cache writes, as each tool records them. agy's count is read from its own files and is close, not exact.

Cost is shown in US dollars at each model's API list price (`server/prices.js`). It is an API-price equivalent, not what a subscription bills. To price a model HRless does not know, add it to `~/.hrless/config.json` (USD per 1M tokens; a key matches any model id that contains it):

```json
{ "prices": { "gemini-3.8-flash": { "in": 0.3, "out": 2.5 } } }
```

## Custom agents

Claude Code, Codex and agy are tracked automatically. Any other agent can report itself by following [HRLESS.md](HRLESS.md). The person icon in the toolbar gives a one-line instruction to paste into that agent's `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or system prompt.

Reports go to `POST /api/report`, which accepts requests from this machine only. An agent that reports the `command` it was started with appears under the Claude agent whose shell call ran that command.

An agent that already saves its conversations as JSON or JSON Lines can be read from those files instead, configured in `~/.hrless/config.json` (or the path in `HRLESS_CONFIG`). HRLESS.md has the format.

## Data sources

| Tool | Files | Subagents |
| --- | --- | --- |
| Claude Code (CLI and desktop) | `~/.claude/projects/*/*.jsonl` | `<session>/subagents/agent-*.jsonl`, linked by `toolUseId` |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | by `parent_thread_id` |
| agy (Antigravity CLI) | `~/.gemini/antigravity-cli/conversations/*.db` | by `parent_references` |

agy and Codex conversations attach to the Claude agent whose `agy` or `codex` shell call was running when they started. When several calls run at once, one can occasionally attach to the wrong agent.

Status comes from each file's last write: **working** within 90 seconds, **idle** within 30 minutes, **done** after that. The page refreshes every 3 seconds.

## Privacy

HRless only reads files. The server listens on `127.0.0.1` and sends nothing anywhere. The page loads no fonts or scripts from the internet.

## Running it by hand

```bash
node server/server.js --open
```

Set `HRLESS_PORT` to change the port. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are respected. The page is reloaded on every request; after changing the server code, restart the server.

## License

MIT
