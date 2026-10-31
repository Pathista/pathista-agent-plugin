#!/usr/bin/env node
// Done gate: a Stop hook (Claude Code) / stop hook (Cursor) that refuses "done" until the project's checks pass and no Pathista run is left open.
// Zero dependencies. Reads the hook input as JSON on stdin; answers on stdout. See README, "Done gate".
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 300;
// All checks together must finish before the hook's own timeout (600 s in hooks/hooks.json), or the agent kills the
// hook and the turn ends unchecked.
const TOTAL_BUDGET_SECONDS = 540;
const OUTPUT_TAIL_LINES = 40;
const OUTPUT_TAIL_CHARACTERS = 4000;
const OUTPUT_BUFFER_BYTES = 256 * 1024 * 1024;

class ConfigError extends Error {}

function readJsonObject(path) {
  let parsed;
  try {
    // Editors on Windows often save a UTF-8 byte order mark, which JSON.parse refuses.
    parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`${path} cannot be read as JSON (${error.message}). Fix the file; the checks did not run.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${path} must contain a JSON object. Fix the file; the checks did not run.`);
  }
  return parsed;
}

// Project checks come only from .done-gate.json; without it there are none. The Pathista check is on unless the file
// says "pathista": false.
export function loadConfig(projectDir) {
  const defaults = { checks: [], pathista: true, maxRetries: DEFAULT_MAX_RETRIES, timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS };
  const configPath = join(projectDir, '.done-gate.json');
  if (!existsSync(configPath)) return defaults;
  const config = readJsonObject(configPath);
  const checks = config.checks === undefined ? [] : config.checks;
  if (!Array.isArray(checks) || checks.some((check) => typeof check !== 'string' || !check.trim())) {
    throw new ConfigError(`${configPath}: "checks" must be a list of command strings. Fix the file; the checks did not run.`);
  }
  if (config.pathista !== undefined && typeof config.pathista !== 'boolean') {
    throw new ConfigError(`${configPath}: "pathista" must be true or false. Fix the file; the checks did not run.`);
  }
  if (config.maxRetries !== undefined && !(Number.isInteger(config.maxRetries) && config.maxRetries >= 1)) {
    throw new ConfigError(`${configPath}: "maxRetries" must be a whole number of at least 1. Fix the file; the checks did not run.`);
  }
  return {
    checks,
    pathista: config.pathista ?? defaults.pathista,
    maxRetries: config.maxRetries ?? defaults.maxRetries,
    timeoutSeconds: config.timeoutSeconds > 0 ? config.timeoutSeconds : defaults.timeoutSeconds,
  };
}

function outputTail(result) {
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return text.split('\n').slice(-OUTPUT_TAIL_LINES).join('\n').slice(-OUTPUT_TAIL_CHARACTERS);
}

export function runChecks(checks, projectDir, timeoutSeconds, totalBudgetSeconds = TOTAL_BUDGET_SECONDS) {
  const failures = [];
  const deadline = Date.now() + totalBudgetSeconds * 1000;
  for (const command of checks) {
    const remainingSeconds = (deadline - Date.now()) / 1000;
    if (remainingSeconds <= 0) {
      failures.push({ command, why: 'not run: the time budget for all checks was used up', output: '' });
      continue;
    }
    const allowedMilliseconds = Math.max(1, Math.floor(Math.min(timeoutSeconds * 1000, remainingSeconds * 1000)));
    const allowedSeconds = allowedMilliseconds / 1000;
    // SIGKILL: a check that ignores SIGTERM must not outlive the budget. Only the shell is killed; on Windows a
    // process the check started may keep running.
    const result = spawnSync(command, {
      cwd: projectDir, shell: true, encoding: 'utf8', timeout: allowedMilliseconds, killSignal: 'SIGKILL', maxBuffer: OUTPUT_BUFFER_BYTES,
    });
    if (result.status === 0) continue;
    const why = result.error?.code === 'ETIMEDOUT'
      ? `timed out after ${Math.round(allowedSeconds)}s`
      : result.error ? `could not run: ${result.error.message}` : `exit code ${result.status}`;
    failures.push({ command, why, output: outputTail(result) });
  }
  return failures;
}

function textOfToolResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('\n');
  return '';
}

function parseRunState(resultText) {
  try {
    const parsed = JSON.parse(resultText);
    return typeof parsed?.runId === 'string' && typeof parsed.status === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Pathista runs still open anywhere in the session transcript (JSONL), not only in the current turn. A tool result
// does not name its tool, so results are matched to Pathista calls by tool_use_id. The last result for a run decides:
// a run seen done or aborted later is not returned. It cannot see runs from other sessions. Subagent records
// (isSidechain) are skipped.
export function findOpenPathistaRuns(transcriptText) {
  const pathistaCallIds = new Set();
  const runs = new Map();
  for (const line of transcriptText.split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.isSidechain) continue;
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'tool_use' && /pathista/i.test(part.name ?? '')) pathistaCallIds.add(part.id);
      if (part?.type !== 'tool_result' || !pathistaCallIds.has(part.tool_use_id)) continue;
      const state = parseRunState(textOfToolResult(part.content));
      if (state) runs.set(state.runId, { status: state.status, step: state.currentStep?.title });
    }
  }
  return [...runs].filter(([, run]) => run.status === 'open').map(([runId, run]) => ({ runId, step: run.step }));
}

function stateFile(sessionId) {
  return join(tmpdir(), 'pathista-done-gate', `${String(sessionId).replace(/[^\w-]/g, '_')}.json`);
}

function readBlockCount(sessionId) {
  try { return JSON.parse(readFileSync(stateFile(sessionId), 'utf8')).blocks ?? 0; } catch { return 0; }
}

function writeBlockCount(sessionId, blocks) {
  const file = stateFile(sessionId);
  if (blocks === 0) { rmSync(file, { force: true }); return; }
  mkdirSync(join(tmpdir(), 'pathista-done-gate'), { recursive: true });
  writeFileSync(file, JSON.stringify({ blocks }));
}

// Cursor names its events in lower case ("stop") and counts the follow-ups itself (loop_count).
const isCursorInput = (input) => input.loop_count !== undefined || input.hook_event_name === 'stop';

// Returns { block: boolean, reason?: string, notice?: string }.
export function decide(input, env = process.env) {
  const isCursor = isCursorInput(input);
  if (isCursor && input.status && input.status !== 'completed') return { block: false };
  const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd || input.workspace_roots?.[0] || process.cwd();
  const sessionId = input.session_id ?? input.conversation_id ?? 'unknown';

  let config;
  const problems = [];
  try {
    config = loadConfig(projectDir);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    config = { checks: [], pathista: true, maxRetries: DEFAULT_MAX_RETRIES, timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS };
    problems.push(error.message);
  }

  // How many times in a row this hook has already sent the agent back.
  let previousBlocks;
  if (isCursor) previousBlocks = input.loop_count ?? 0;
  else if (input.stop_hook_active) previousBlocks = readBlockCount(sessionId);
  else previousBlocks = 0;

  for (const failure of runChecks(config.checks, projectDir, config.timeoutSeconds)) {
    problems.push(`Check failed (${failure.why}): ${failure.command}\n${failure.output}`.trimEnd());
  }
  // A transcript we cannot read must not hide the result of the checks: say so and go on.
  const warnings = [];
  if (config.pathista && input.transcript_path) {
    try {
      for (const run of findOpenPathistaRuns(readFileSync(input.transcript_path, 'utf8'))) {
        problems.push(`Pathista run ${run.runId} is still open${run.step ? ` at step "${run.step}"` : ''}. Finish the step (currentStep, then advance) or tell the user why you stop.`);
      }
    } catch (error) {
      // A transcript that is not there (yet) is normal; any other read failure is worth saying.
      if (error.code !== 'ENOENT') warnings.push(`Done gate could not read the session transcript (${error.message}); open Pathista runs were not checked.`);
    }
  }

  if (problems.length === 0) {
    if (!isCursor) writeBlockCount(sessionId, 0);
    return warnings.length ? { block: false, notice: warnings.join('\n') } : { block: false };
  }
  if (previousBlocks >= config.maxRetries) {
    if (!isCursor) writeBlockCount(sessionId, 0);
    return { block: false, notice: `Done gate gave up after ${config.maxRetries} retries; still failing:\n${[...problems, ...warnings].join('\n\n')}` };
  }
  if (!isCursor) writeBlockCount(sessionId, previousBlocks + 1);
  return { block: true, reason: `You are not done yet (attempt ${previousBlocks + 1} of ${config.maxRetries}). Fix this, then finish again:\n\n${[...problems, ...warnings].join('\n\n')}` };
}

export function formatOutput(input, outcome) {
  const isCursor = isCursorInput(input);
  if (outcome.block) return isCursor ? { followup_message: outcome.reason } : { decision: 'block', reason: outcome.reason };
  return !isCursor && outcome.notice ? { systemMessage: outcome.notice } : {};
}

// Compare real paths: a hooks directory reached through a link must still run the hook.
const entryPath = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(resolve(process.argv[1])) : undefined;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  let output;
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    output = formatOutput(input, decide(input));
  } catch (error) {
    // Never crash silently: a crash is a non-blocking error and the user would think the gate is on.
    output = { systemMessage: `Done gate could not run (${error.message}); this turn was not checked.` };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
