// The project's runner (#14 HANDOFF-07 to HANDOFF-09): what .github/workflows/build.yml runs to build a build request
// with the coding agent the project chose. Overworld only records the request and starts the workflow; everything here
// runs in the project's own GitHub Actions, as an ordinary agent with its own Overworld token.
//
//   node scripts/build/runner.mjs start     take the request: claim its behaviours (MCP-04), write the prompt; skip if it's taken
//   node scripts/build/runner.mjs agent     install and run the project's agent on the prompt, or one that can stand in
//   node scripts/build/runner.mjs decide    after the agent: open a pull request, or stop, and why
//   node scripts/build/runner.mjs finish    a pull request is named on the claim, which then holds until it is deployed
//                                            (HANDOFF-11); a run that stopped releases it with why (MCP-09),
//                                            and ask()s what the agent couldn't settle
//
// Which agent (HANDOFF-08): the one the project's own agent files are for (CLAUDE.md is Claude Code's, .aider.conf.yml
// and CONVENTIONS.md are aider's), unless repository variables say otherwise: BUILD_AGENT (claude-code or aider),
// BUILD_MODEL, and optionally BUILD_AGENT_VERSION and BUILD_AGENT_KEY_ENV. If it can't be used, the runner falls back to
// one that can, with the same key, and says so. The agent's key is the BUILD_AGENT_KEY secret, handed only to the agent's
// own step. Overworld is reached with OVERWORLD_URL (a variable) and OVERWORLD_AGENT_TOKEN (a secret: an agent token
// made in Overworld for the runner, which can be revoked on its own).

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Where an unfinished build says why: the agent writes it, the runner turns it into an ask() and never commits it. */
export const BLOCKED_FILE = 'BLOCKED.md';
// The longest claim there is, so it outlasts the job. Once the pull request is named on it, it holds until the deploy.
const CLAIM_MINUTES = 480;

/**
 * The coding agents the runner knows (HANDOFF-08): how each is installed and run, and which environment variable its key
 * goes in. Another agent is one more entry here, and nothing else changes.
 */
export const AGENTS = {
  'claude-code': {
    install: (version) => ['npm', ['install', '--global', `@anthropic-ai/claude-code${version ? `@${version}` : ''}`]],
    run: ({ model, prompt }) => ['claude', ['--print', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep', ...(model ? ['--model', model] : [])]],
    keyEnv: () => 'ANTHROPIC_API_KEY',
  },
  aider: {
    install: (version) => ['python3', ['-m', 'pip', 'install', '--user', `aider-chat${version ? `==${version}` : ''}`]],
    run: ({ model, promptFile }) => ['aider', ['--yes-always', '--no-check-update', '--no-show-model-warnings', '--auto-commits', '--test-cmd', 'npm test', '--auto-test', '--message-file', promptFile, ...(model ? ['--model', model] : [])]],
    // Aider talks to any provider: the model's name says which key it reads. A local model needs none.
    keyEnv: (model = '') =>
      /^(ollama|ollama_chat|lm_studio)\//.test(model) ? null
        : /^(anthropic\/|claude)/.test(model) ? 'ANTHROPIC_API_KEY'
          : /^(gemini\/|gemini)/.test(model) ? 'GEMINI_API_KEY'
            : /^openrouter\//.test(model) ? 'OPENROUTER_API_KEY'
              : /^deepseek/.test(model) ? 'DEEPSEEK_API_KEY'
                : 'OPENAI_API_KEY',
  },
};

// The project's own agent files, and the agent each is for. AGENTS.md is read by every agent, so it chooses none.
const AGENT_FILES = [['CLAUDE.md', 'claude-code'], ['.claude/settings.json', 'claude-code'], ['.aider.conf.yml', 'aider'], ['CONVENTIONS.md', 'aider']];

/**
 * Which agent and model build (HANDOFF-08): a setting wins; then the project's own agent files; then Claude Code.
 * @param {{ setting?: string, model?: string, files: Record<string, string> }} o  files: the agent files there are, with their text
 * @returns {{ agent: string, model?: string, from: string }}
 */
export function chooseAgent({ setting, model, files = {} }) {
  if (setting?.trim()) return { agent: setting.trim(), model: model || undefined, from: 'the BUILD_AGENT setting' };
  const found = AGENT_FILES.find(([f]) => f in files);
  if (!found) return { agent: 'claude-code', model: model || undefined, from: 'the default' };
  const [file, agent] = found;
  // Aider's own config can name its model.
  const named = file === '.aider.conf.yml' ? files[file].match(/^model:\s*["']?([^"'\s#]+)/m)?.[1] : undefined;
  return { agent, model: model || named, from: file };
}

/**
 * The agents to try, in order: the chosen one, then any other that can work with the same key (HANDOFF-08). Claude Code
 * needs an Anthropic key; aider takes any, so it can stand in for Claude Code on the same Anthropic model.
 */
export function candidates({ agent, model, keyEnv }) {
  const env = keyEnv || agentFor(agent).keyEnv(model);
  const out = [{ agent, model }];
  if (agent === 'claude-code') out.push({ agent: 'aider', model: model ? `anthropic/${model}` : 'sonnet', keyEnv: env });
  if (agent === 'aider' && env === 'ANTHROPIC_API_KEY') out.push({ agent: 'claude-code', model: model?.replace(/^anthropic\//, '') });
  return out;
}

/** The agent the settings choose, or an error naming the ones there are. */
function agentFor(name) {
  const agent = AGENTS[String(name ?? '').trim() || 'claude-code'];
  if (!agent) throw new Error(`BUILD_AGENT "${name}" isn't one the runner knows: ${Object.keys(AGENTS).join(', ')}`);
  return agent;
}

/**
 * How to run the chosen agent (HANDOFF-08): the command, its arguments, and the environment that carries its key. The key
 * is only ever in the environment, never in the command line.
 */
export function agentRun({ agent, model, key, keyEnv, prompt, promptFile }) {
  const a = agentFor(agent);
  const [cmd, args] = a.run({ model, prompt, promptFile });
  const envName = keyEnv || a.keyEnv(model);
  return { cmd, args, env: envName && key ? { [envName]: key } : {} };
}

/** How to install the chosen agent. */
export const agentInstall = ({ agent, version }) => agentFor(agent).install(version);

/** What the runner tells the agent first: it is alone, on its own branch, and how to say it couldn't finish. */
export const runnerPreamble = (branch) =>
  [
    `You are building unattended, in GitHub Actions, on the branch ${branch}. Nobody will answer you here.`,
    'The behaviours below are already claimed for you, and you have no Overworld tools: where the prompt says to claim, ask() or handoff(), the runner does it.',
    'Commit your work on this branch as you go. Do not push and do not open a pull request: when you stop, the runner runs npm test and opens the pull request if it passes. Never change .github/workflows.',
    `If you can't finish (tests you can't make pass, or a question you can't settle from the repository), write why in ${BLOCKED_FILE} at the repository root, as the question a person should answer, and stop. The runner puts it on the item.`,
    '',
    '---',
    '',
  ].join('\n');

/** A client for Overworld's MCP server, as an agent uses it: one tool call, its structured result or its refusal. */
export function mcpClient({ url, token, fetchImpl = fetch }) {
  let id = 0;
  return async function call(name, args = {}) {
    const res = await fetchImpl(new URL('/api/mcp', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`Overworld refused ${name}: ${body.error?.message ?? body.error ?? res.status}`);
    const r = body.result;
    return r.isError ? { refused: r.structuredContent?.error ?? r.content?.[0]?.text ?? 'refused' } : r.structuredContent;
  };
}

/**
 * Take the build request (HANDOFF-06): find it among those still waiting, and claim its behaviours. An open session may
 * have taken it first (HANDOFF-10); then the runner has nothing to do, and says so.
 * @returns {Promise<{ skip: true, why: string } | { skip: false, item: string, behaviours: string[], prompt: string }>}
 */
export async function start({ mcp, request, item, runId, branch }) {
  // What started the run names a branch and goes into commands: only an item key or a request id gets through.
  if (item && !/^(issue-\d+|node-[\w-]+)$/.test(item)) throw new Error(`"${item}" isn't an item key`);
  if (request && !/^[\w-]{1,40}$/.test(request)) throw new Error(`"${request}" isn't a build request id`);
  if (!request && !item) throw new Error('Name the build request, or its item');
  const { build_requests: waiting = [] } = await mcp('next_work', { limit: 50 });
  const r = waiting.find((x) => (request ? x.request === request : x.item === item));
  if (!r) return { skip: true, why: `Build request ${request || `for ${item}`} isn't waiting any more: someone has taken it, or it was built.` };
  const took = await mcp('claim', { behaviours: r.behaviours, minutes: CLAIM_MINUTES, request_key: `runner-${runId}` });
  if (took.refused) return { skip: true, why: `Someone else took it first: ${took.refused}` };
  return { skip: false, request: r.request, item: r.item, behaviours: took.claimed, prompt: runnerPreamble(branch) + r.prompt };
}

/**
 * After the agent stops: a pull request when there is work and the tests pass (HANDOFF-07), otherwise stop, and why
 * (HANDOFF-09). What the agent wrote in BLOCKED.md is always why.
 */
export function decide({ commits, testsPass, blocked }) {
  if (blocked?.trim()) return { open: false, why: blocked.trim() };
  if (!commits) return { open: false, why: 'The agent stopped without changing anything.' };
  if (!testsPass) return { open: false, why: 'The tests fail on what the agent built, so no pull request was opened.' };
  return { open: true };
}

/**
 * When the run ends. A pull request is named on the claim, which then holds through review and merge until the deploy that
 * carries it succeeds (HANDOFF-11): the work isn't done until people can use it. A run that stopped releases it with a note saying why and where the unfinished work is
 * (HANDOFF-09, MCP-09), so nothing is left claimed and idle; what the agent couldn't settle also goes on the item as a
 * question (MCP-05), for a person to answer there.
 */
export async function finish({ mcp, item, behaviours, pr, why, branch, pushed, blocked, runUrl, used }) {
  const key = (what) => `${what}-${branch}`.replace(/[^\w.:-]/g, '-').slice(0, 100); // a retried step does it once (MCP-12)
  const sure = async (name, args) => {
    const r = await mcp(name, args);
    if (r?.refused) throw new Error(`Overworld refused ${name}: ${r.refused}`);
    return r;
  };
  if (pr) return sure('claim', { behaviours, pull_request: Number(String(pr).match(/(\d+)\/?$/)?.[1]), request_key: key('pull') });
  if (blocked?.trim()) await sure('ask', { place: item, question: `The runner couldn't finish ${behaviours.join(', ')}: ${blocked.trim()}`, request_key: key('ask') });
  const note = `The runner stopped on ${behaviours.join(', ')}${used ? `, built with ${used}` : ''}: ${why}${pushed ? ` The unfinished work is on the branch ${branch}.` : ''}${runUrl ? ` Its run: ${runUrl}` : ''}`;
  return sure('handoff', { behaviours, note, request_key: key('handoff') });
}

// ---------- the workflow's steps ----------

const env = process.env;
const output = (pairs) => {
  const text = Object.entries(pairs).map(([k, v]) => (String(v).includes('\n') ? `${k}<<EOF_${k}\n${v}\nEOF_${k}` : `${k}=${v}`)).join('\n');
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${text}\n`);
  else console.log(text);
};
const git = (...args) => spawnSync('git', args, { encoding: 'utf8' }).stdout.trim();
const settings = () => ({ agent: env.BUILD_AGENT, model: env.BUILD_MODEL, version: env.BUILD_AGENT_VERSION, keyEnv: env.BUILD_AGENT_KEY_ENV });
const run = (cmd, args, extra = {}) => spawnSync(cmd, args, { stdio: 'inherit', env: { ...env, ...extra } }).status ?? 1;
const blockedText = () => (existsSync(BLOCKED_FILE) ? readFileSync(BLOCKED_FILE, 'utf8').slice(0, 3000) : '');

async function main(step) {
  const mcp = () => mcpClient({ url: env.OVERWORLD_URL, token: env.OVERWORLD_AGENT_TOKEN });
  switch (step) {
    case 'start': {
      const r = await start({ mcp: mcp(), request: env.REQUEST, item: env.ITEM, runId: env.GITHUB_RUN_ID, branch: env.BRANCH });
      if (r.skip) {
        console.log(r.why);
        return output({ skip: 'true' });
      }
      writeFileSync(env.PROMPT_FILE, r.prompt);
      return output({ skip: 'false', item: r.item, behaviours: r.behaviours.join(',') });
    }
    case 'agent': {
      const s = settings();
      const files = Object.fromEntries(AGENT_FILES.filter(([f]) => existsSync(f)).map(([f]) => [f, readFileSync(f, 'utf8')]));
      const chosen = chooseAgent({ setting: s.agent, model: s.model, files });
      const prompt = readFileSync(env.PROMPT_FILE, 'utf8');
      const notes = [];
      for (const c of candidates({ ...chosen, keyEnv: s.keyEnv })) {
        const [icmd, iargs] = agentInstall({ agent: c.agent, version: c.agent === chosen.agent ? s.version : undefined });
        if (run(icmd, iargs) !== 0) {
          notes.push(`${c.agent} couldn't be installed`);
          continue;
        }
        const { cmd, args, env: keyed } = agentRun({ ...c, keyEnv: c.keyEnv ?? s.keyEnv, key: env.BUILD_AGENT_KEY, prompt, promptFile: env.PROMPT_FILE });
        const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...env, ...keyed, BUILD_AGENT_KEY: '' } });
        // An agent that wouldn't start can't be used; one that ran and stopped has done its work, whatever its exit: decide
        // reads what it left behind.
        if (r.error || r.status === 127) {
          notes.push(`${c.agent} wouldn't start`);
          continue;
        }
        const used = `${c.agent}${c.model ? ` (${c.model})` : ''}, chosen by ${c.agent === chosen.agent ? chosen.from : `falling back from ${chosen.agent}: ${notes.join('; ')}`}`;
        return output({ used });
      }
      return output({ used: '', why: `No agent could be used: ${notes.join('; ')}.` });
    }
    case 'decide': {
      const blocked = blockedText();
      if (existsSync(BLOCKED_FILE)) run('git', ['rm', '--quiet', '--cached', '--ignore-unmatch', BLOCKED_FILE]);
      // Work the agent left uncommitted is kept, never lost.
      if (git('status', '--porcelain', '--', '.', `:!${BLOCKED_FILE}`)) {
        run('git', ['add', '--all', '--', '.', `:!${BLOCKED_FILE}`]);
        run('git', ['commit', '--quiet', '-m', 'Work the agent left uncommitted']);
      }
      const commits = Number(git('rev-list', '--count', `${env.BASE_SHA}..HEAD`)) || 0;
      const testsPass = commits > 0 && !blocked && run('npm', ['test']) === 0;
      const d = decide({ commits, testsPass, blocked });
      return output({ open: String(d.open), push: String(commits > 0), why: d.why ?? '' });
    }
    case 'finish': {
      const behaviours = String(env.BEHAVIOURS ?? '').split(',').filter(Boolean);
      if (!behaviours.length) return;
      await finish({ mcp: mcp(), item: env.ITEM, behaviours, pr: env.PR_URL, why: env.WHY || 'The run failed before the agent finished.', branch: env.BRANCH, pushed: env.PUSHED === 'true', blocked: blockedText(), runUrl: env.RUN_URL, used: env.USED });
      return;
    }
    default:
      throw new Error(`Unknown step "${step}": start, install, agent, decide or finish`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv[2]).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
