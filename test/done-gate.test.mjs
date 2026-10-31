import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runChecks } from '../hooks/done-gate.mjs';

const gateScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'done-gate.mjs');

function makeProject(config) {
  const projectDir = mkdtempSync(join(tmpdir(), 'done-gate-project-'));
  if (config) writeFileSync(join(projectDir, '.done-gate.json'), JSON.stringify(config));
  return projectDir;
}

// Runs the hook exactly as the agent does: a process, JSON on stdin, JSON on stdout.
function runHook(projectDir, input) {
  const result = spawnSync('node', [gateScript], {
    input: JSON.stringify({ cwd: projectDir, ...input }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const failingCheck = 'node -e "console.error(\'3 tests failed\'); process.exit(1)"';
const passingCheck = 'node -e "process.exit(0)"';
let sessionCounter = 0;
const newSessionId = () => `test-session-${process.pid}-${Date.now()}-${sessionCounter++}`;

// A Claude Code transcript as the agent writes it: the tool call and its result are separate records,
// linked by tool_use_id, and a result carries no tool name.
const pathistaRunId = '31176e03-db0b-4db1-b6f3-278869bf7144';
const userPrompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
let toolCounter = 0;
function pathistaCall(toolName, result) {
  const id = `toolu_${toolCounter++}`;
  return [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__pathista__${toolName}`, input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(result) }] }] } },
  ];
}
const otherToolCall = () => {
  const id = `toolu_${toolCounter++}`;
  const resultText = JSON.stringify({ runId: pathistaRunId, status: 'open' });
  return [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: resultText }] } },
  ];
};
const openRun = { runId: pathistaRunId, status: 'open', currentStep: { id: 'plan', title: 'Plan' } };
const doneRun = { runId: pathistaRunId, status: 'done' };

function writeTranscript(records) {
  const transcriptPath = join(mkdtempSync(join(tmpdir(), 'done-gate-transcript-')), 'transcript.jsonl');
  writeFileSync(transcriptPath, `${records.flat().map((record) => JSON.stringify(record)).join('\n')}\n`);
  return transcriptPath;
}
const pathistaTranscript = (status) => writeTranscript([userPrompt('start the run'), pathistaCall('advance', status === 'open' ? openRun : doneRun)]);

test('a failing check blocks the end of the turn and shows the output', () => {
  const output = runHook(makeProject({ checks: [failingCheck] }), { session_id: newSessionId(), hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /Check failed/);
  assert.match(output.reason, /3 tests failed/);
});

test('passing checks let the turn end', () => {
  const output = runHook(makeProject({ checks: [passingCheck] }), { session_id: newSessionId(), hook_event_name: 'Stop', stop_hook_active: false });
  assert.deepEqual(output, {});
});

test('a project with no checks is never blocked', () => {
  assert.deepEqual(runHook(makeProject(), { session_id: newSessionId(), stop_hook_active: false }), {});
});

test('the loop guard stops blocking after the retry cap', () => {
  const projectDir = makeProject({ checks: [failingCheck], maxRetries: 2 });
  const sessionId = newSessionId();
  const first = runHook(projectDir, { session_id: sessionId, stop_hook_active: false });
  const second = runHook(projectDir, { session_id: sessionId, stop_hook_active: true });
  const third = runHook(projectDir, { session_id: sessionId, stop_hook_active: true });
  assert.equal(first.decision, 'block');
  assert.equal(second.decision, 'block');
  assert.equal(third.decision, undefined);
  assert.match(third.systemMessage, /gave up after 2 retries/);
});

test('a new user turn starts the retry count again', () => {
  const projectDir = makeProject({ checks: [failingCheck], maxRetries: 1 });
  const sessionId = newSessionId();
  assert.equal(runHook(projectDir, { session_id: sessionId, stop_hook_active: false }).decision, 'block');
  assert.equal(runHook(projectDir, { session_id: sessionId, stop_hook_active: false }).decision, 'block');
});

test('Cursor: a failing check returns a follow-up message, and loop_count is the cap', () => {
  const projectDir = makeProject({ checks: [failingCheck], maxRetries: 2 });
  const base = { conversation_id: newSessionId(), status: 'completed', workspace_roots: [projectDir] };
  assert.match(runHook(projectDir, { ...base, loop_count: 0 }).followup_message, /3 tests failed/);
  assert.match(runHook(projectDir, { ...base, loop_count: 1 }).followup_message, /attempt 2 of 2/);
  assert.equal(runHook(projectDir, { ...base, loop_count: 2 }).followup_message, undefined);
});

test('Cursor: an aborted turn is not gated', () => {
  const projectDir = makeProject({ checks: [failingCheck] });
  assert.deepEqual(runHook(projectDir, { conversation_id: newSessionId(), status: 'aborted', loop_count: 0 }), {});
});

test('with Pathista, an open run step blocks even when the checks pass', () => {
  const projectDir = makeProject({ checks: [passingCheck] });
  const output = runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false, transcript_path: pathistaTranscript('open') });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /Pathista run 31176e03-db0b-4db1-b6f3-278869bf7144 is still open at step "Plan"/);
});

test('with Pathista, a finished run does not block', () => {
  const projectDir = makeProject({ checks: [passingCheck] });
  assert.deepEqual(runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false, transcript_path: pathistaTranscript('done') }), {});
});

test('without a config there are no project checks, even when package.json has a failing test script', () => {
  const projectDir = makeProject();
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }));
  assert.deepEqual(runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false }), {});
});

test('with Pathista, a run finished later in the turn does not block (the done result has no tool name or "pathista")', () => {
  const projectDir = makeProject({ checks: [passingCheck] });
  const transcriptPath = writeTranscript([userPrompt('go'), pathistaCall('startRun', openRun), pathistaCall('advance', doneRun)]);
  assert.deepEqual(runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false, transcript_path: transcriptPath }), {});
});

test('with Pathista, a result of another tool that looks like a run is ignored', () => {
  const projectDir = makeProject({ checks: [passingCheck] });
  const transcriptPath = writeTranscript([userPrompt('go'), otherToolCall()]);
  assert.deepEqual(runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false, transcript_path: transcriptPath }), {});
});

test('with Pathista, a run left open in an earlier turn blocks this turn', () => {
  const projectDir = makeProject({ checks: [passingCheck] });
  const transcriptPath = writeTranscript([userPrompt('start'), pathistaCall('startRun', openRun), userPrompt('unrelated question')]);
  const output = runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false, transcript_path: transcriptPath });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /Pathista run 31176e03-db0b-4db1-b6f3-278869bf7144 is still open/);
});

test('with Pathista, a run opened in an earlier turn and finished in a later one does not block', () => {
  const projectDir = makeProject({ checks: [passingCheck] });
  const transcriptPath = writeTranscript([userPrompt('start'), pathistaCall('startRun', openRun), userPrompt('go on'), pathistaCall('advance', doneRun)]);
  assert.deepEqual(runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false, transcript_path: transcriptPath }), {});
});

test('with Pathista, an aborted run does not block', () => {
  const projectDir = makeProject({ checks: [passingCheck] });
  const transcriptPath = writeTranscript([userPrompt('start'), pathistaCall('startRun', openRun), pathistaCall('advance', { runId: pathistaRunId, status: 'aborted' })]);
  assert.deepEqual(runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false, transcript_path: transcriptPath }), {});
});

test('the Pathista check is on without any .done-gate.json', () => {
  const output = runHook(makeProject(), { session_id: newSessionId(), stop_hook_active: false, transcript_path: pathistaTranscript('open') });
  assert.equal(output.decision, 'block');
});

test('"pathista": false in .done-gate.json switches the Pathista check off, the project checks stay on', () => {
  const projectDir = makeProject({ pathista: false, checks: [failingCheck] });
  const output = runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false, transcript_path: pathistaTranscript('open') });
  assert.equal(output.decision, 'block');
  assert.doesNotMatch(output.reason, /Pathista/);
  const passing = makeProject({ pathista: false, checks: [passingCheck] });
  assert.deepEqual(runHook(passing, { session_id: newSessionId(), stop_hook_active: false, transcript_path: pathistaTranscript('open') }), {});
});

test('"pathista" that is not true or false is a configuration error', () => {
  const output = runHook(makeProject({ pathista: 'no' }), { session_id: newSessionId(), stop_hook_active: false });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /"pathista" must be true or false/);
});

test('a .done-gate.json with a UTF-8 byte order mark is read', () => {
  const projectDir = makeProject();
  writeFileSync(join(projectDir, '.done-gate.json'), `\uFEFF${JSON.stringify({ checks: [failingCheck] })}`);
  const output = runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /3 tests failed/);
});

test('"checks": null is a configuration error, not a silent off switch', () => {
  const projectDir = makeProject();
  writeFileSync(join(projectDir, '.done-gate.json'), '{ "checks": null }');
  const output = runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /"checks" must be a list/);
});

test('a transcript file that does not exist yet is not an error: no notice, checks still decide', () => {
  const missingTranscript = join(mkdtempSync(join(tmpdir(), 'done-gate-transcript-')), 'missing.jsonl');
  assert.deepEqual(runHook(makeProject({ checks: [passingCheck] }), { session_id: newSessionId(), stop_hook_active: false, transcript_path: missingTranscript }), {});
  const failing = runHook(makeProject({ checks: [failingCheck] }), { session_id: newSessionId(), stop_hook_active: false, transcript_path: missingTranscript });
  assert.equal(failing.decision, 'block');
  assert.doesNotMatch(failing.reason, /transcript/);
});

test('a .done-gate.json with only "pathista": false makes the hook do nothing', () => {
  assert.deepEqual(runHook(makeProject({ pathista: false }), { session_id: newSessionId(), stop_hook_active: false, transcript_path: pathistaTranscript('open') }), {});
});

test('a broken .done-gate.json does not switch the Pathista check off', () => {
  const output = runHook(makeProject({ pathista: false, maxRetries: 0 }), { session_id: newSessionId(), stop_hook_active: false, transcript_path: pathistaTranscript('open') });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /maxRetries/);
  assert.match(output.reason, /Pathista run/);
});

test('a transcript that cannot be read does not lose the result of the checks', () => {
  const unreadableTranscript = mkdtempSync(join(tmpdir(), 'done-gate-transcript-dir-'));
  const failing = runHook(makeProject({ checks: [failingCheck] }), { session_id: newSessionId(), stop_hook_active: false, transcript_path: unreadableTranscript });
  assert.equal(failing.decision, 'block');
  assert.match(failing.reason, /3 tests failed/);
  assert.match(failing.reason, /transcript/);
  const passing = runHook(makeProject({ checks: [passingCheck] }), { session_id: newSessionId(), stop_hook_active: false, transcript_path: unreadableTranscript });
  assert.equal(passing.decision, undefined);
  assert.match(passing.systemMessage, /transcript/);
});

test('the Pathista block is bounded by the retry cap too', () => {
  const projectDir = makeProject({ checks: [passingCheck], maxRetries: 1 });
  const sessionId = newSessionId();
  const transcriptPath = pathistaTranscript('open');
  assert.equal(runHook(projectDir, { session_id: sessionId, stop_hook_active: false, transcript_path: transcriptPath }).decision, 'block');
  assert.equal(runHook(projectDir, { session_id: sessionId, stop_hook_active: true, transcript_path: transcriptPath }).decision, undefined);
});

test('a passing check that prints a lot is still a pass', () => {
  const noisyCheck = 'node -e "process.stdout.write(String.fromCharCode(120).repeat(3000000))"';
  assert.deepEqual(runHook(makeProject({ checks: [noisyCheck] }), { session_id: newSessionId(), stop_hook_active: false }), {});
});

test('a failing check that prints one huge line is reported with a bounded tail', () => {
  const noisyFailure = 'node -e "process.stdout.write(String.fromCharCode(120).repeat(3000000)); process.exit(1)"';
  const output = runHook(makeProject({ checks: [noisyFailure] }), { session_id: newSessionId(), stop_hook_active: false });
  assert.equal(output.decision, 'block');
  assert.ok(output.reason.length < 20000);
});

test('an unreadable .done-gate.json blocks with a message instead of switching the gate off', () => {
  const projectDir = makeProject();
  writeFileSync(join(projectDir, '.done-gate.json'), '{ "checks": [ "npm test", ] }');
  const output = runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /\.done-gate\.json/);
});

test('a check that is not a command string blocks with a message', () => {
  const output = runHook(makeProject({ checks: [null] }), { session_id: newSessionId(), stop_hook_active: false });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /\.done-gate\.json/);
});

test('the project is found from cwd when CLAUDE_PROJECT_DIR is not set', () => {
  const projectDir = makeProject({ checks: [failingCheck] });
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  const result = spawnSync('node', [gateScript], { input: JSON.stringify({ cwd: projectDir, session_id: newSessionId() }), encoding: 'utf8', env });
  assert.equal(JSON.parse(result.stdout).decision, 'block');
});

test('the hook still runs when started through a linked directory', () => {
  const projectDir = makeProject({ checks: [failingCheck] });
  const linkParent = mkdtempSync(join(tmpdir(), 'done-gate-link-'));
  const linkedHooksDir = join(linkParent, 'linked-hooks');
  symlinkSync(dirname(gateScript), linkedHooksDir, 'junction');
  const result = spawnSync('node', [join(linkedHooksDir, 'done-gate.mjs')], {
    input: JSON.stringify({ cwd: projectDir, session_id: newSessionId() }), encoding: 'utf8',
  });
  assert.equal(JSON.parse(result.stdout).decision, 'block');
});

test('checks share one time budget, and a check that does not get its turn counts as failed', () => {
  const hangingCheck = 'node -e "setTimeout(() => {}, 20000)"';
  const started = Date.now();
  const failures = runChecks([hangingCheck, hangingCheck], tmpdir(), 300, 1);
  assert.ok(Date.now() - started < 10000);
  assert.equal(failures.length, 2);
  assert.match(failures[0].why, /timed out/);
  assert.match(failures[1].why, /time budget/);
});

test('with Pathista, calls made by a subagent (sidechain) are not the parent turn\'s runs', () => {
  const projectDir = makeProject({ checks: [passingCheck] });
  const sidechain = pathistaCall('startRun', openRun).map((record) => ({ ...record, isSidechain: true }));
  const transcriptPath = writeTranscript([userPrompt('go'), sidechain]);
  assert.deepEqual(runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false, transcript_path: transcriptPath }), {});
});

for (const [name, fileContent] of [['null', 'null'], ['a list', '[]'], ['a string', '"npm test"']]) {
  test(`a .done-gate.json that is ${name} blocks with a message`, () => {
    const projectDir = makeProject();
    writeFileSync(join(projectDir, '.done-gate.json'), fileContent);
    const output = runHook(projectDir, { session_id: newSessionId(), stop_hook_active: false });
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /\.done-gate\.json/);
  });
}

test('maxRetries below 1 is a configuration error, not a silent off switch', () => {
  const output = runHook(makeProject({ checks: [failingCheck], maxRetries: 0 }), { session_id: newSessionId(), stop_hook_active: false });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /maxRetries/);
});

test('a fractional timeout does not crash the check runner', () => {
  const failures = runChecks([passingCheck], tmpdir(), 0.0125);
  assert.ok(Array.isArray(failures));
});

test('input that is not JSON gives a visible notice instead of a silent crash', () => {
  const result = spawnSync('node', [gateScript], { input: 'this is not json', encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).systemMessage, /Done gate/);
});
