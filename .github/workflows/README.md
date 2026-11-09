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
empty to skip the budget alert.

```sh
aws cloudformation deploy --region ca-central-1 \
  --stack-name ci-for-projectmap \
  --template-file infra/ci-bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --tags app=projectmap \
  --parameter-overrides CreateOidcProvider=true BudgetEmail=<your email> BudgetUsd=5
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
