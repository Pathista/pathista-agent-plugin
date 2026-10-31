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
claude plugin marketplace add Pathista/pathista-agent-plugin
claude plugin install pathista@pathista
```

Then, in a session, run `/mcp`, pick **pathista** and sign in. Or, without the plugin, only the server:
`claude mcp add --transport http pathista https://pathista.com/mcp`.

**Cursor**

Add the server to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{ "mcpServers": { "Pathista": { "url": "https://pathista.com/mcp" } } }
```

Then open **Cursor Settings → MCP**, choose **Connect** next to Pathista and sign in. The plugin is also listed on
[cursor.directory](https://cursor.directory/plugins/pathista). Cursor asks you to approve each Pathista tool call in the
agent chat before it runs: a run takes several calls per step, so expect a few approvals.

**Skills only** (any agent that reads `SKILL.md`): `npx skills add Pathista/pathista-agent-plugin`.

**ChatGPT and Claude in the browser:** connect `https://pathista.com/mcp` as a connector; the steps are on
[pathista.com](https://pathista.com/?utm_source=github&utm_medium=plugin&utm_campaign=plugin-repo).

## What is inside

| Part | What it does |
|---|---|
| `.mcp.json`, `mcp.json` | The Pathista MCP server for Claude Code and Cursor (HTTP, OAuth sign-in) |
| `skills/run-workflow` | Runs a saved workflow step by step: start, do the step, close todos with evidence, advance, finish |
| `skills/make-workflow` | Turns a process you describe into a workflow: draft, check with `validateWorkflow`, save |
| `hooks/` | The done gate: a Stop hook that blocks "done" until your checks pass and no Pathista run is left open |
| `.claude-plugin/`, `.cursor-plugin/` | Plugin manifests and the Claude Code marketplace file |

## Done gate: no "done" until the checks pass

A Stop hook that has two checks, and each works on its own:

1. **Your project's checks**, which run only when you ask for them with a `.done-gate.json`. If one fails, the agent is
   sent back with the failing output and has to fix it before it can finish.
2. **Open Pathista runs**, which is **on by default**, with or without a `.done-gate.json`. If a run started or used
   anywhere in the session is still open, the agent cannot finish.

Zero dependencies; it needs Node 18 or newer on your PATH.

**Turn on project checks.** Put a `.done-gate.json` in your project root with the commands to run:

```json
{ "checks": ["npm test", "npm run lint"], "maxRetries": 3, "timeoutSeconds": 300 }
```

Without that file the hook runs no project command at all: it never guesses `npm test` or anything else. The checks run
one after another through your shell (`cmd.exe` on Windows), each for at most `timeoutSeconds`, and all together for at
most 9 minutes (the hook's own timeout is 10). A check that runs too long is killed, but on Windows only its shell: a
process the check started may keep running. The file may start with a UTF-8 byte order mark. A broken file (not JSON,
`"checks"` that is not a list of command strings, `"checks": null`, `"pathista"` that is not true or false, or
`maxRetries` below 1) blocks with a message that names the file; it does not switch the gate off.

It runs your checks every time the agent ends a turn, also for a short question that changed nothing, so keep them fast.

**Turn off the Pathista check.** Add `"pathista": false` to `.done-gate.json`. Your project checks are not affected. A
file with only `{ "pathista": false }` makes the hook do nothing. In a broken file the switch is ignored: the Pathista
check stays on, next to the message about the file.

**Claude Code.** Installing the plugin (above) turns it on. Without the plugin, copy `hooks/done-gate.mjs` into your
project and add to `.claude/settings.json`:

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/hooks/done-gate.mjs\"", "timeout": 600 } ] } ] } }
```

**Cursor.** Copy `hooks/done-gate.mjs` to `.cursor/hooks/` and `hooks/cursor-hooks.json` to `.cursor/hooks.json`. Cursor
cannot refuse a stop: the hook sends the failure as the next message instead. Cursor's own `loop_limit` (5 in that file)
caps the retries, so a larger `maxRetries` has no effect there. When the cap is reached the turn just ends; Cursor shows
no notice. Whether the hook also finds Pathista runs on Cursor depends on the format of Cursor's transcript file, which
is not tested here; the checks work either way.

**With Pathista.** The hook reads the Claude Code session transcript and matches results to calls of tools whose name
contains `pathista` (such as `mcp__pathista__advance`; a server you registered under another name is not gated). Every
run it finds there counts, from the whole session and not only the current turn, as long as the last result it got for
that run says `"status":"open"`. A run seen finished or aborted later in the transcript is not counted. The hook then
refuses to finish and names each open run and its step. A run you parked on purpose (for example while it waits for
your answer) is blocked like any other, up to `maxRetries` times, before the hook lets the turn end; the same happens
again at the end of every later turn until you close the run or turn the check off. If the transcript
cannot be read (a missing file is not an error), the hook says so (Claude Code only: Cursor shows no notice), still reports the result of your checks, and does not block because of Pathista.

**What it does not do.**
- It does not read what the agent says. A turn with no failing check and no open run passes, even if the agent claims
  something false.
- It is only as good as your checks: no `.done-gate.json`, no project checks.
- It stops after `maxRetries` blocks in a row (default 3) and lets the turn end with a notice, so it cannot loop forever.
  A stuck agent is the user's call, not the hook's.
- The Pathista check is a heuristic on the transcript, not a query to the server: it does not see a run that was
  closed or changed outside the chat, and it does not see runs of other sessions. Hooks are not allowed in a public
  OpenAI plugin, so this is for Claude Code and Cursor only.
- Stop hooks do not run when you interrupt the agent.

Tests: `node --test test/done-gate.test.mjs`. More on making agents prove their work:
[pathista.com](https://pathista.com/?utm_source=github&utm_medium=plugin&utm_campaign=done-gate).

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
