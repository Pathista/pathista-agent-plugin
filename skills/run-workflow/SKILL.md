---
name: run-workflow
description: Use when the user asks to run, start, continue or follow a saved process with Pathista (a release checklist, a QA pass, an onboarding, a weekly report), or says "start my <name> workflow". Drives one Pathista run step by step through the pathista MCP tools.
---

# Run a Pathista workflow

Pathista keeps the user's processes as workflows on pathista.com. A run hands you one step at a time; the server keeps
the position, the checklist and the history, so nothing gets skipped and the run can be resumed later.

1. Find the workflow: call `listWorkflows` (pass `name` to filter). If none fits, say so and offer the `make-workflow`
   skill instead of improvising a process.
2. Start it: `startRun` with the workflow id and a short `title` saying what this run is about (for example
   "Release 2.4.0", not the workflow's name). If it reports an open run, continue that one unless the user wants a new
   run. Give the user the run page link from the result: they can watch every step there.
3. Keep the `runId` and pass it on every later call (Claude Code sends no chat id).
4. On each step: do exactly what the step's text says, nothing from later steps. When the step has todos, close them
   with `completeTodo` only after the work is really done, with evidence: what you ran, checked or produced (a command
   and its result, a file path, a test summary). "Done" alone is refused, and that is the point.
5. Move on with `advance`. When the step offers several edges, name the one that matches what happened (for example a
   failed check takes the "fix" edge, not "release"). When a step asks for a summary, pass `note`.
6. Record decisions the next steps need with `addNote`. If unsure how something works, call `help` with a topic
   (`runs`, `todos`, `model`).
7. On the final step, do its work and call `advance` once more: that finishes the run. Tell the user what was done and
   give the run link again.

Never mark a todo done to get past a step, never invent evidence, and stop to ask the user when a step needs their
decision or credentials.
