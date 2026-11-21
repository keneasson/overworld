# Delivery

How a change gets from a pull request to production (#27). We test in production behind feature
flags, so there is no staging. A pull request can ask for a temporary preview when a change needs
to be seen running before it merges.

| Workflow | When | What |
|---|---|---|
| `ci.yml` | every pull request, including forks | `npm test` and the build (SHIP-01) |
| `production.yml` | a push to main | the tests, then deploy, smoke test, and roll back to the last version that passed if the smoke test fails (SHIP-02, SHIP-03) |
| `preview.yml` | a pull request labelled `preview`, from this repository | its own stack `projectmap-pr-<N>` with an empty table, one comment with the URL, torn down on close or unlabel (SHIP-04 to SHIP-07). Sync with GitHub is off in a preview (SHIP-11). |
| `sweep.yml` | daily at 07:17 UTC, or by hand | tears down previews past their rules, and deletes deployment records nobody needs (SHIP-07, SHIP-08) |
| `cla.yml` | pull requests | the CLA check |
| `build.yml` | a build request from Overworld (`repository_dispatch: overworld-build`), or by hand | the project's runner: builds the request with the configured coding agent on `build/<item>-<run>`, and opens a pull request (#14 HANDOFF-07 to HANDOFF-09) |

The rules (the limit of 3 previews, the 7 days, which version to roll back to) are in
`scripts/ci/rules.mjs` and tested in `scripts/test/ci.test.mjs`. `scripts/ci/run.mjs` gathers the
facts from GitHub and AWS and acts on them.

## Limits and clean-up

| What | Limit | Who clears it |
|---|---|---|
| Previews | 3 at once; gone on close, on unlabel, or after 7 days without a push | `preview.yml`, then `sweep.yml` |
| A preview's table and logs | go with its stack | `scripts/ci/run.mjs teardown` (the template retains tables, so production's survives) |
| Deploy bundles in S3 | 7 days | the bucket's lifecycle rule |
| Lambda logs | 3 days for previews, 14 for production | CloudWatch retention |
| Lambda versions | none are published | nothing to clear |
| Deployment records | previews' go once the preview is gone; production keeps its newest 20 | `sweep.yml` |
| Actions artifacts | 3 days (none are uploaded today; a test enforces the limit) | GitHub |
| Workflow run logs | 30 days | the repository setting below |
| Actions cache | 7 days unused, 10 GB | GitHub |

Free tier: the repository is public, so Actions minutes are free. Lambda, DynamoDB on demand, S3
and CloudWatch at this size stay within the free tier. The budget alert is the second line of
defence.

## One-time setup (the maintainer, by hand)

CI never creates its own permissions, so these steps are run once by someone with admin access to
the AWS account and the repository. Run them from `Overworld/`, where `.conf/` lives.

**1. AWS: the bootstrap stack.** If the account already has GitHub's OIDC provider
(`aws iam list-open-id-connect-providers`), pass `CreateOidcProvider=false`. Leave `BudgetEmail`
empty to skip the budget alert. If `gh api repos/keneasson/overworld/actions/oidc/customization/sub` shows
`use_immutable_subject: true`, pass the part of `sub_claim_prefix` after `repo:` as `GitHubRepoIds`.

```sh
aws cloudformation deploy --region ca-central-1 \
  --stack-name ci-for-projectmap \
  --template-file infra/ci-bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --tags app=projectmap \
  --parameter-overrides CreateOidcProvider=true BudgetEmail=<your email> BudgetUsd=5 \
    GitHubRepoIds=<owner@id/repo@id, if the repository uses immutable OIDC subjects>
```

**2. GitHub: the variables, from the stack's outputs.**

```sh
out() { aws cloudformation describe-stacks --region ca-central-1 --stack-name ci-for-projectmap --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
gh variable set AWS_REGION           -R keneasson/overworld --body ca-central-1
gh variable set AWS_ROLE_ARN         -R keneasson/overworld --body "$(out RoleArn)"
gh variable set ARTIFACT_BUCKET      -R keneasson/overworld --body "$(out ArtifactBucket)"
gh variable set PERMISSIONS_BOUNDARY -R keneasson/overworld --body "$(out BoundaryArn)"
# The GitHub App sync writes as (#3). None of these is secret, and only production gets them (SHIP-11).
gh variable set SYNC_APP_ID          -R keneasson/overworld --body 5672649
gh variable set SYNC_INSTALLATION_ID -R keneasson/overworld --body 179984521
gh variable set SYNC_APP_SLUG        -R keneasson/overworld --body overworldmap
```

**3. GitHub: the environments.** Production deploys only from main.

```sh
gh api -X PUT repos/keneasson/overworld/environments/production --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api -X POST repos/keneasson/overworld/environments/production/deployment-branch-policies -f name=main -f type=branch
gh api -X PUT repos/keneasson/overworld/environments/preview
```

**4. GitHub: the secrets.** Neither is printed. The production key is the one already in
`.conf/deploy.json`. The preview key is new, and is kept in `.conf/preview.json`, so you can enter
it in a preview.

```sh
node -e "process.stdout.write(require('./.conf/deploy.json').accessKey)" | gh secret set PROJECTMAP_ACCESS_KEY --env production -R keneasson/overworld
node -e "const k=require('crypto').randomBytes(18).toString('base64url'); require('fs').writeFileSync('.conf/preview.json', JSON.stringify({ accessKey: k }), { mode: 0o600 }); process.stdout.write(k)" \
  | gh secret set PREVIEW_ACCESS_KEY --env preview -R keneasson/overworld
```

**5. GitHub: the label and the log retention.**

```sh
gh label create preview -R keneasson/overworld --color 1d76db --description "Deploy a preview of this pull request (gone on close, unlabel, or after 7 days)"
gh api -X PUT repos/keneasson/overworld/actions/permissions/artifact-and-log-retention -F days=30
```

**6. GitHub: the runner's secrets and variable (#14).** `build.yml` can't take a build request without these.
What each one is for is under [The runner](#the-runner-14). Get the three values first:

- `BUILD_AGENT_KEY`: an Anthropic API key, from https://console.anthropic.com/settings/keys (Create Key). Name it for the runner, so it can be revoked alone.
- `OVERWORLD_AGENT_TOKEN`: in Overworld (https://overworld.kene.info), open this project, open the menu, and under Agents choose
  **Connect an agent**. Name it `Build runner` and choose **Create its token**. Copy only the token from the snippet it shows; it's shown once.
- `BUILD_GITHUB_TOKEN`: at https://github.com/settings/personal-access-tokens/new, a fine-grained token with Resource owner `keneasson`,
  Repository access **Only select repositories**: `keneasson/overworld`, and Repository permissions **Contents: Read and write** and
  **Pull requests: Read and write** (Metadata: Read is added for you). Add **Workflows: Read and write** only if the runner should be
  able to push changes to `.github/workflows/`. Note its expiry date: the runner's pushes fail once it expires.

Then each `gh secret set` asks for its value, so it isn't echoed or kept in your shell history:

```sh
gh secret set BUILD_AGENT_KEY       -R keneasson/overworld
gh secret set OVERWORLD_AGENT_TOKEN -R keneasson/overworld
gh secret set BUILD_GITHUB_TOKEN    -R keneasson/overworld
gh variable set OVERWORLD_URL       -R keneasson/overworld --body https://overworld.kene.info
gh secret list -R keneasson/overworld && gh variable list -R keneasson/overworld   # check: all four are listed
```

The other `BUILD_*` variables are optional; leave them unset to use Claude Code on its default model.

**Optional: expire SAM's own bucket.** Local `npm run deploy` still uploads to SAM's managed bucket,
which keeps every bundle forever. A lifecycle rule clears it:

```sh
b=$(aws cloudformation describe-stacks --region ca-central-1 --stack-name aws-sam-cli-managed-default --query "Stacks[0].Outputs[?OutputKey=='SourceBucket'].OutputValue" --output text)
aws s3api put-bucket-lifecycle-configuration --bucket "$b" --lifecycle-configuration '{"Rules":[{"ID":"expire-deploy-bundles","Status":"Enabled","Filter":{},"Expiration":{"Days":7}}]}'
```

## After setup

- The first production run puts the permissions boundary on the app function's role. After that,
  every deploy keeps it, including a local `npm run deploy`, because SAM keeps a parameter's
  previous value.
- Once CI deploys production, prefer it to `npm run deploy`. A local deploy still works, but it
  can race CI's deploy.

## The runner (#14)

Choosing **Build** in Overworld records a build request and sends this repository an `overworld-build`
`repository_dispatch`. `build.yml` then takes the request like any agent: it claims the behaviours
(so the map shows the bulldozer), runs the coding agent on the request's prompt on a branch of its
own, runs `npm test`, and opens a pull request that goes through CI and review like anyone's. If it
can't finish, it releases the claim with a note saying why (and asks the agent's question on the item),
so the card says what happened. A pull request keeps the claim: it is released once the work is merged
and deployed, by hand for now. If an agent session takes the request first, the runner finds it gone and
stops without doing anything.

It never pushes to main: the agent's step has no GitHub credentials, and the only push is to
`build/…`. It never sees production secrets and never reaches AWS.

**Which agent (HANDOFF-08)** is the project's, not Overworld's. The runner uses the agent the repository's own agent
files are for: `CLAUDE.md` (or `.claude/settings.json`) is Claude Code's; `.aider.conf.yml` or `CONVENTIONS.md` is
aider's, and `.aider.conf.yml` can name the model. `AGENTS.md` is read by every agent, so it chooses none. With no
agent files, it is Claude Code. Repository variables override all of that:

| Variable | What | Example |
|---|---|---|
| `BUILD_AGENT` | `claude-code` (the default) or `aider` | `aider` |
| `BUILD_MODEL` | the model, as the agent names it | `claude-sonnet-5-5`, `gpt-5`, `gemini/gemini-2.5-pro`, `ollama_chat/qwen3-coder` |
| `BUILD_AGENT_VERSION` | optional: pin the agent's version | |
| `BUILD_AGENT_KEY_ENV` | optional: the environment variable the key goes in, when the runner can't tell from the model | `OPENAI_API_KEY` |
| `OVERWORLD_URL` | where Overworld runs | |

Secrets (the maintainer adds these by hand; Overworld never holds them):

| Secret | What |
|---|---|
| `BUILD_AGENT_KEY` | the agent's key for its model's provider (Anthropic, OpenAI, Google, OpenRouter…); none for a local model |
| `OVERWORLD_AGENT_TOKEN` | an agent token made in Overworld (Connect an agent) for the runner, so its claims say it was the runner; revoke it there to stop it |
| `BUILD_GITHUB_TOKEN` | a fine-grained token for this repository only, with Contents and Pull requests read and write. Without it the runner uses the workflow's own token, and its pull requests don't start CI |

Also, once:

- In the repository's Actions settings, allow GitHub Actions to create pull requests (needed only without `BUILD_GITHUB_TOKEN`).
- Give the Overworld GitHub App **Contents: write**, which `repository_dispatch` needs. Without it, Build still records the
  request and an open agent session takes it, and the card says the runner couldn't be started.

If the chosen agent can't be used (it won't install, or won't start), the runner falls back to one that can work with
the same key: aider stands in for Claude Code on the same Anthropic model, and Claude Code for aider when aider's model is
Anthropic's. The pull request says which agent built it and why, and so does the note on the item when a run stops.

Claude Code runs as `claude --print` with edits allowed and its tools limited to the repository's files and shell. Aider runs with
`--yes-always --auto-test --test-cmd "npm test"`, and with any provider aider supports, including a local model.
