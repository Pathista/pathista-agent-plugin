---
name: make-workflow
description: Use when the user wants to turn a repeated process into a reusable Pathista workflow (a release checklist, a code review routine, a QA pass, an onboarding), or says "save this as a workflow" or "make a checklist I can run every time". Drafts the steps with the user, checks them and saves them through the pathista MCP tools.
---

# Make a Pathista workflow

A workflow is a graph of steps: each step has the text the agent reads when it gets there, an optional checklist of
todos that must be closed with evidence, and edges to the next steps (loops and choices are allowed). The user then runs
it again and again with the `run-workflow` skill.

1. Ask what the process is for and walk through it with the user: the steps in order, what "done" means for each one
   (that becomes the step's todos), and where it branches or loops (for example "tests fail: back to fix").
2. Read the authoring rules before writing: call `help` with topic `authoring`, and `patterns` for shapes that work
   (review loop, approval gate, bounded retry).
3. Write each step's text as an instruction to an agent that sees only that step: what to do, what to check, what to
   hand over. Keep one job per step. Put the checks into todos, phrased so evidence can prove them.
4. Check the draft with `validateWorkflow` and fix every issue it reports. Show the user the steps and the drawing from
   the result, and change what they ask for.
5. Save it with `createWorkflow` once the user agrees. Give them the workflow link, and offer to start the first run.

To change an existing workflow, read it with `getWorkflow` and send the changes with `editWorkflow` (it needs the version
you read; on a conflict, read again and redo the change).
