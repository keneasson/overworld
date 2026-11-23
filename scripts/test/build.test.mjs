// The project's runner (#14 HANDOFF-07 to HANDOFF-10). Its decisions are tested directly, with a fake Overworld; what only
// the workflow can promise (no push to main, no production secrets) is checked by reading it. Runs on GitHub prove the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentInstall, agentRun, candidates, chooseAgent, decide, finish, start } from '../build/runner.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8');
const stepsOf = (text) => text.split(/\n {6}- /).slice(1);
const code = workflow.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); // what runs, without the comments

/** A fake Overworld: the build requests waiting, and every tool call made. */
function overworld({ waiting = [], refuse = null } = {}) {
  const calls = [];
  const mcp = async (name, args) => {
    calls.push([name, args]);
    if (args.request_key != null && !/^[\w.:-]{1,100}$/.test(args.request_key)) return { refused: 'request_key: letters, digits and . _ : - only, at most 100' };
    if (name === 'next_work') return { work: [], build_requests: waiting };
    if (name === 'claim') return refuse ? { refused: refuse } : { claimed: args.behaviours, ...(args.pull_request ? { pull_request: args.pull_request } : {}) };
    return {};
  };
  return { mcp, calls };
}
const request = { request: 'r1', item: 'issue-14', behaviours: ['HANDOFF-05'], prompt: 'Build this behaviour of #14…' };

test('HANDOFF-07 the runner builds in GitHub Actions on a branch of its own, opens a pull request, never pushes to main and holds no production secrets', () => {
  assert.match(workflow, /repository_dispatch:\n\s+types: \[overworld-build\]/, 'Build starts it');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(code, /environment:|id-token|aws|SYNC_|ACCESS_KEY|deploy/i, 'no production environment, AWS or deploy secrets');
  const secrets = [...new Set([...workflow.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(secrets, ['BUILD_AGENT_KEY', 'BUILD_GITHUB_TOKEN', 'OVERWORLD_AGENT_TOKEN']);
  assert.match(workflow, /persist-credentials: false/, 'the checkout leaves no credentials behind for the agent');
  const steps = stepsOf(workflow);
  const agent = steps.find((s) => s.includes('runner.mjs agent'));
  assert.match(agent, /BUILD_AGENT_KEY: \$\{\{ secrets\.BUILD_AGENT_KEY \}\}/, "only the agent's step gets its key");
  assert.doesNotMatch(agent, /GH_TOKEN|github\.token|BUILD_GITHUB_TOKEN/, 'and no GitHub credentials');
  assert.match(agent, /OVERWORLD_AGENT_TOKEN: ''/, 'nor the runner’s Overworld token');
  for (const s of steps.filter((x) => x.includes('BUILD_AGENT_KEY'))) assert.ok(s === agent, 'no other step sees the key');
  const pushes = steps.filter((s) => /git push/.test(s));
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /"HEAD:refs\/heads\/\$\{BRANCH\}"/);
  assert.match(workflow, /BRANCH: build\//, 'its own branch, never main');
  assert.match(steps.find((s) => s.includes('gh pr create')), /--base main --head "\$BRANCH"/, 'its result is a pull request');
});

test('HANDOFF-08 the agent and model come from the project\'s agent files or its settings, Claude Code or an open-source agent on any provider, falling back to one that can be used; the key only ever in its environment', () => {
  const claude = agentRun({ agent: 'claude-code', model: 'claude-sonnet-5-5', key: 'sk-a', prompt: 'Build it' });
  assert.equal(claude.cmd, 'claude');
  assert.deepEqual(claude.env, { ANTHROPIC_API_KEY: 'sk-a' });
  assert.ok(claude.args.includes('claude-sonnet-5-5') && claude.args.includes('Build it'));
  assert.equal(agentRun({ agent: '', key: 'k', prompt: 'p' }).cmd, 'claude', 'Claude Code when nothing is set');

  const keyOf = (model) => Object.keys(agentRun({ agent: 'aider', model, key: 'k', promptFile: '/tmp/p.md' }).env)[0] ?? null;
  assert.equal(agentRun({ agent: 'aider', model: 'gpt-5', key: 'k', promptFile: '/tmp/p.md' }).cmd, 'aider');
  assert.deepEqual([keyOf('gpt-5'), keyOf('anthropic/claude-sonnet-5-5'), keyOf('gemini/gemini-2.5-pro'), keyOf('openrouter/qwen/qwen3-coder'), keyOf('ollama_chat/qwen3-coder')], ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', null], "the model says which provider's key, and a local model needs none");
  assert.deepEqual(agentRun({ agent: 'aider', model: 'my-model', key: 'k', keyEnv: 'MISTRAL_API_KEY', promptFile: 'p' }).env, { MISTRAL_API_KEY: 'k' }, 'or a setting says');
  for (const a of ['claude-code', 'aider']) {
    const r = agentRun({ agent: a, model: 'm', key: 'secret-key', prompt: 'p', promptFile: 'p' });
    assert.ok(!r.args.join(' ').includes('secret-key'), `${a}: the key is never on the command line`);
  }
  assert.deepEqual(agentInstall({ agent: 'aider', version: '0.86.1' })[1].at(-1), 'aider-chat==0.86.1', 'a version can be pinned');
  assert.throws(() => agentRun({ agent: 'devin' }), /claude-code, aider/, 'an unknown agent says which there are');
  // Which agent: the project's own agent files say, a setting overrides them, and Claude Code when nothing does.
  assert.deepEqual(chooseAgent({ files: { 'CLAUDE.md': '# Rules', 'AGENTS.md': '' } }), { agent: 'claude-code', model: undefined, from: 'CLAUDE.md' });
  assert.deepEqual(chooseAgent({ files: { '.aider.conf.yml': 'model: gemini/gemini-2.5-pro\nauto-commits: true\n' } }), { agent: 'aider', model: 'gemini/gemini-2.5-pro', from: '.aider.conf.yml' });
  assert.equal(chooseAgent({ files: { 'AGENTS.md': '' } }).agent, 'claude-code', 'AGENTS.md is every agent\'s, so it chooses none');
  assert.deepEqual(chooseAgent({ setting: 'aider', model: 'gpt-5', files: { 'CLAUDE.md': '' } }), { agent: 'aider', model: 'gpt-5', from: 'the BUILD_AGENT setting' });
  // One that can't be used falls back to one that can, with the same key.
  assert.deepEqual(candidates({ agent: 'claude-code', model: 'claude-sonnet-5-5' }).map((c) => [c.agent, c.model]), [['claude-code', 'claude-sonnet-5-5'], ['aider', 'anthropic/claude-sonnet-5-5']]);
  assert.equal(Object.keys(agentRun({ ...candidates({ agent: 'claude-code', model: 'claude-sonnet-5-5' })[1], key: 'k', promptFile: 'p' }).env)[0], 'ANTHROPIC_API_KEY');
  assert.deepEqual(candidates({ agent: 'aider', model: 'gpt-5' }).map((c) => c.agent), ['aider'], 'nothing else can use an OpenAI key');
  const vars = [...new Set([...workflow.matchAll(/vars\.(\w+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(vars, ['BUILD_AGENT', 'BUILD_AGENT_KEY_ENV', 'BUILD_AGENT_VERSION', 'BUILD_MODEL', 'OVERWORLD_URL'], 'the settings are repository variables, not code');
});

test('HANDOFF-09 HANDOFF-11 a runner that cannot finish says why on the item, asks what it could not settle, and releases its claim; one that opened a pull request names it on the claim, which holds until it is deployed', async () => {
  assert.deepEqual(decide({ commits: 2, testsPass: true, blocked: '' }), { open: true });
  assert.match(decide({ commits: 2, testsPass: false, blocked: '' }).why, /tests fail/);
  assert.match(decide({ commits: 0, testsPass: false, blocked: '' }).why, /without changing anything/);
  assert.equal(decide({ commits: 3, testsPass: true, blocked: 'Should Build need write access, or be the maintainer only?' }).open, false, 'a question it could not settle stops it');

  const failed = overworld();
  await finish({ mcp: failed.mcp, item: 'issue-14', behaviours: ['HANDOFF-05'], why: 'The tests fail on what the agent built, so no pull request was opened.', branch: 'build/issue-14-1', pushed: true, runUrl: 'https://run' });
  await assert.rejects(finish({ mcp: async () => ({ refused: 'You hold no claim on HANDOFF-05' }), item: 'issue-14', behaviours: ['HANDOFF-05'], why: 'x', branch: 'b' }), /refused handoff/, 'a release that fails fails the run, never quietly');
  assert.deepEqual(failed.calls.map(([n]) => n), ['handoff'], 'released');
  assert.match(failed.calls[0][1].note, /stopped on HANDOFF-05: The tests fail.*on the branch build\/issue-14-1.*https:\/\/run/);

  const asked = overworld();
  await finish({ mcp: asked.mcp, item: 'issue-14', behaviours: ['HANDOFF-05'], why: 'Who may build?', blocked: 'Who may build?', branch: 'b' });
  assert.deepEqual(asked.calls.map(([n, a]) => [n, a.place ?? a.behaviours]), [['ask', 'issue-14'], ['handoff', ['HANDOFF-05']]]);
  assert.match(asked.calls[0][1].question, /Who may build\?/);

  const opened = overworld();
  await finish({ mcp: opened.mcp, item: 'issue-14', behaviours: ['HANDOFF-05'], pr: 'https://github.com/o/r/pull/7', branch: 'build/issue-14-1', used: 'aider (gpt-5), chosen by the BUILD_AGENT setting' });
  assert.deepEqual(opened.calls.map(([n, a]) => [n, a.behaviours, a.pull_request, a.built_with]), [['claim', ['HANDOFF-05'], 7, 'aider (gpt-5), chosen by the BUILD_AGENT setting']], 'the claim names its pull request and the agent that built it, and is not released');
  const finishing = stepsOf(workflow).find((s) => s.includes('runner.mjs finish'));
  assert.match(finishing, /if: always\(\)/, 'it finishes however the run ended, so a crash never leaves the claim idle');
});

test('HANDOFF-06 HANDOFF-10 the runner takes a request by claiming it, and does nothing when an open session took it first', async () => {
  const fresh = overworld({ waiting: [request] });
  const took = await start({ mcp: fresh.mcp, request: 'r1', runId: '9', branch: 'build/issue-14-9' });
  assert.deepEqual(fresh.calls[1], ['claim', { behaviours: ['HANDOFF-05'], minutes: 480, request_key: 'runner-9' }]);
  assert.equal(took.skip, false);
  assert.match(took.prompt, /unattended, in GitHub Actions, on the branch build\/issue-14-9[\s\S]*Build this behaviour of #14/);

  const gone = overworld({ waiting: [] });
  assert.equal((await start({ mcp: gone.mcp, request: 'r1', runId: '9', branch: 'b' })).skip, true);
  assert.deepEqual(gone.calls.map(([n]) => n), ['next_work'], 'nothing claimed');
  assert.equal((await start({ mcp: overworld({ waiting: [request], refuse: 'Already claimed: HANDOFF-05' }).mcp, item: 'issue-14', runId: '9', branch: 'b' })).skip, true, 'a session that claimed it a moment earlier wins');
  await assert.rejects(start({ mcp: fresh.mcp, item: 'issue-14; rm -rf /', runId: '9', branch: 'b' }), /isn't an item key/);
});
