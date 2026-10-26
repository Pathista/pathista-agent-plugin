# Pathista for Claude Code and Cursor

Your agent says "done" and skipped step 4. Pathista fixes that by giving it **one step at a time**.

You save a process once, as a workflow: a release checklist, a QA pass, a code review routine. When you start it, the
agent only sees the current step. Each checklist item closes only with evidence (the command it ran, the test output, the
file it wrote), so "done" alone does not get it past a step. The run's position and history live on
[pathista.com](https://pathista.com/?utm_source=github&utm_medium=plugin&utm_campaign=plugin-repo), so you can watch every
step on the run page and pick the run up again tomorrow.

This repository is the plugin: it connects your agent to the Pathista MCP server (`https://pathista.com/mcp`) and adds
two skills. A free Pathista account is enough to try it; you sign in in the browser the first time the agent uses it.

## Install

**Claude Code**

```
claude plugin marketplace add cleverspark/pathista-agent-plugin
claude plugin install pathista@pathista
```

Then, in a session, run `/mcp`, pick **pathista** and sign in. Or, without the plugin, only the server:
`claude mcp add --transport http pathista https://pathista.com/mcp`.

**Cursor**

Add the server to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{ "mcpServers": { "Pathista": { "url": "https://pathista.com/mcp" } } }
```

Then open **Cursor Settings → MCP**, choose **Connect** next to Pathista and sign in.

**Skills only** (any agent that reads `SKILL.md`): `npx skills add cleverspark/pathista-agent-plugin`.

**ChatGPT and Claude in the browser:** connect `https://pathista.com/mcp` as a connector; the steps are on
[pathista.com](https://pathista.com/?utm_source=github&utm_medium=plugin&utm_campaign=plugin-repo).

## What is inside

| Part | What it does |
|---|---|
| `.mcp.json`, `mcp.json` | The Pathista MCP server for Claude Code and Cursor (HTTP, OAuth sign-in) |
| `skills/run-workflow` | Runs a saved workflow step by step: start, do the step, close todos with evidence, advance, finish |
| `skills/make-workflow` | Turns a process you describe into a workflow: draft, check with `validateWorkflow`, save |
| `.claude-plugin/`, `.cursor-plugin/` | Plugin manifests and the Claude Code marketplace file |

## Try it

```
> make a release checklist workflow: tests, changelog, version bump, tag, deploy, smoke test
> start my release checklist for 2.4.0
```

The agent drafts the workflow with you, saves it, then runs it one step at a time and links the run page.

## Privacy

The plugin itself stores nothing. The MCP server keeps your workflows and runs in your Pathista account:
[privacy](https://pathista.com/privacy), [terms](https://pathista.com/terms).

## License

MIT
