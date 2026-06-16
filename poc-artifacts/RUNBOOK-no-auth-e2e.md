# Runbook — POC: run amazonq E2E on a CodeBuild runner (no-auth), and where SSO starts

**Status: WORKING ✅** (2026-06-16). Two GitHub Actions workflows run green on a
CodeBuild-managed runner, on Amazon-owned compute, with no credentials on GitHub:
- `poc-lsp-rc-linux.yml` — credential-free LSP `initialize` handshake against the RC server.
- `poc-e2e-linux.yml` — real VS Code launched, amazonq E2E spec `test/e2e/lsp` (5 passing).

This runbook is the replay recipe + the four environment fixes we had to make, so you can
rebuild this from scratch and then extend it to SSO/auth tests.

---

## 0. What actually got proven (and what didn't)

✅ Proven:
- GitHub webhook (`WORKFLOW_JOB_QUEUED`) → CodeBuild matches the runner label → ephemeral
  runner picks up the job. Compute is in our AWS account; no creds on GitHub.
- RC artifact download + **SHA384 verification** against `manifest.json`.
- The RC language server (`aws-lsp-codewhisperer.js`) launches and speaks LSP
  (`HANDSHAKE OK — server "AWS CodeWhisperer" v1.70.0`).
- Real VS Code (1.124.2) downloaded + launched under Xvfb; amazonq E2E harness runs the
  `test/e2e/lsp` spec → **5 passing** (exercises the `__AMAZONQLSP_PATH` override + RC
  version-resolution code paths).

⚠️ NOT yet proven (this is where the SSO work begins — see §6):
- The `lsp` spec **mocks** the LSP download, so it tests installer/override LOGIC, not the
  actual RC binary driven THROUGH the extension.
- Linux only (not Windows, the real regression target).
- No authenticated behavior (chat/inline) — those `.skip()` without SSO.

> **Read pass/fail from the GitHub Actions UI, never the CodeBuild console.** CodeBuild is
> only the host; it reports "Succeeded" as long as the runner started/exited cleanly, even
> when the tests failed. The runner streams real step logs back to GitHub — that's the truth.

---

## 1. Fixed inputs (what we used)

| Thing | Value |
|---|---|
| AWS account | `876778438035` |
| Read-only access | `ada credentials update --once --account 876778438035 --role ReadOnly --provider isengard --profile poc-ro-876778438035` |
| CodeBuild project | `VSCode-test-poc` (region **us-east-1**) |
| CodeBuild image | `aws/codebuild/amazonlinux-x86_64-standard:6.0` (**Amazon Linux**, LINUX_CONTAINER) — this matters, see fix #4 |
| Service role | `codebuild-VSCode-test-poc-service-role` (Logs/S3 only — enough for no-auth) |
| Fork | `manojkondisetti/amazon-q-vscode-fork` |
| Working branch | `poc-lsp-rc` (POC code) ; `main` (for workflow indexing) |
| RC under test | `aws/language-servers` release `agentic-rc-1.70.0` |

---

## 2. One-time setup (replicate from scratch)

1. **CodeBuild ↔ GitHub connection** (account-level, once): CodeBuild console → Settings →
   GitHub → Connect (GitHub App or token). Required before a webhook can be created.
2. **CodeBuild Runner project** pointed at the fork (`source.location =
   https://github.com/manojkondisetti/amazon-q-vscode-fork`), `artifacts: NO_ARTIFACTS`,
   Linux env above. (We used the console; CLI equivalent is in `codebuild-runner-project.md`.)
3. **Webhook — must be exactly `WORKFLOW_JOB_QUEUED`** (this is the #1 gotcha):
   ```bash
   aws codebuild update-webhook --project-name VSCode-test-poc --region us-east-1 \
     --filter-groups '[[{"type":"EVENT","pattern":"WORKFLOW_JOB_QUEUED"}]]'
   ```
   ⚠️ NOT `PULL_REQUEST_CREATED`, and do NOT comma-join it with other events — a runner
   project triggers ONLY on `WORKFLOW_JOB_QUEUED`, or the GitHub job hangs forever.
4. **GitHub repo Variable** (fork → Settings → Secrets and variables → Actions → **Variables**):
   ```bash
   gh variable set POC_CODEBUILD_PROJECT --repo manojkondisetti/amazon-q-vscode-fork --body VSCode-test-poc
   ```
   This feeds the runner label `runs-on: codebuild-${{ vars.POC_CODEBUILD_PROJECT }}-...`;
   it MUST match the project name exactly. (It's a Variable, not a Secret — no credential.)

## 3. Repo setup (the workflows)

Copy these into the fork and commit:
- `.github/workflows/poc-lsp-rc-linux.yml`  (handshake smoke)
- `.github/workflows/poc-e2e-linux.yml`     (real VS Code E2E)
- `poc-artifacts/scripts/download-verify-rc.sh`
- `poc-artifacts/smoke-handshake/handshake-smoke.mjs`

> **Indexing gotcha:** GitHub only makes a `workflow_dispatch` workflow runnable once it
> exists on the **default branch** (`main`). We committed the workflow files to BOTH
> `poc-lsp-rc` (where they run from) and `main` (so `gh workflow run` / the Run button see
> them). If `gh workflow run <file>` returns `HTTP 404 ... not found on the default branch`,
> the file isn't on `main` yet.

## 4. Run them

```bash
# Handshake smoke (fast, ~40s)
gh workflow run poc-lsp-rc-linux.yml --repo manojkondisetti/amazon-q-vscode-fork \
  --ref poc-lsp-rc -f release_tag=agentic-rc-1.70.0 -f platform=linux-x64 -f reason="smoke"

# Full VS Code E2E (~10 min: npm ci + VS Code download + xvfb + tests)
gh workflow run poc-e2e-linux.yml --repo manojkondisetti/amazon-q-vscode-fork \
  --ref poc-lsp-rc -f test_dir=test/e2e/lsp -f vscode_version=stable -f reason="e2e"

# Watch (authoritative result is here, NOT CodeBuild):
gh run list --repo manojkondisetti/amazon-q-vscode-fork --workflow poc-e2e-linux.yml --limit 1
gh run watch <run-id> --repo manojkondisetti/amazon-q-vscode-fork --exit-status
gh run view  <run-id> --repo manojkondisetti/amazon-q-vscode-fork --log   # see test output
```

---

## 5. The four bugs we hit and fixed (so you don't re-hit them)

These are all **CodeBuild-runner vs GitHub-hosted-runner** differences. Keep them in mind for
any new workflow on this infra.

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | `HTTP 422 ... Unrecognized named-value: 'runner'` on dispatch | `runner.*` context is NOT available in **job-level `env:`** (only inside steps) | Use `${{ github.workspace }}` instead of `${{ runner.temp }}` at job-env scope |
| 2 | `No sha384 for linux-x64-servers.zip in manifest.json` | Manifest content `filename` is the generic **`servers.zip`**; the platform name (`linux-x64-servers.zip`) only appears in the **`url`** | Match the content whose `url` **endswith** the zip name, not `filename ==` |
| 3 | `sysctl: permission denied on key "fs.inotify.max_user_watches"` (exit 255) | CodeBuild runner is a **container**; that sysctl is read-only (GitHub-hosted hosts allow it) | Make the watcher-bump step **non-fatal** (`... || true`); it's only a perf tweak |
| 4 | `sudo: apt-get: command not found` from `coactions/setup-xvfb` | The CodeBuild image is **Amazon Linux** (dnf/yum), but that action runs `apt-get` (Debian/Ubuntu) | Drop the action; `sudo dnf install -y xorg-x11-server-Xvfb`, then `Xvfb :99 ... & export DISPLAY=:99` (the internal MaxDome `test-entry.sh` pattern) |

Evidence (green runs): handshake `27586204203`, E2E `27587069466`.

---

## 6. Handoff: extending to SSO / authenticated E2E tests

The no-auth path is done. To run the specs that actually authenticate (chat/inline, and to
drive the **real RC binary through the extension**), the additions are:

1. **Pick auth-requiring specs:** e.g. `packages/amazonq/test/e2e/amazonq/chat.test.ts` or
   `inline/inline.test.ts`. They call `loginToIdC()` / `registerAuthHook('amazonq-test-account')`
   and `.skip()` when `isSSOTestEnvironmentAvailable()` is false (needs `TEST_SSO_STARTURL` +
   `TEST_SSO_REGION`).
2. **Wire the existing non-interactive auth harness** (do NOT build a new secret fetch — see
   decisions D4): set workflow env `AUTH_UTIL_LAMBDA_ARN`, `TEST_SSO_STARTURL`,
   `TEST_SSO_REGION`, `AWS_TOOLKIT_AUTOMATION` (≠ `local`). `registerAuthHook` intercepts the
   SSO device-code flow and invokes the auth Lambda, which reads the `amazonq-test-account`
   Secrets Manager secret; the SSO bearer token lands in `~/.aws/sso/cache`.
3. **Grant the CodeBuild service role `lambda:InvokeFunction`** on `AUTH_UTIL_LAMBDA_ARN`
   (the Lambda itself holds the Secrets Manager read). This is an IAM **write** — current POC
   role has Logs/S3 only. Confirm the auth Lambda + secret exist / are reachable from
   `876778438035` (likely owned cross-account by the amazon-q-vscode team — ask them).
4. **Drive the actual RC through the extension:** download+extract the RC (reuse
   `download-verify-rc.sh`), set `__AMAZONQLSP_PATH` to the extracted folder so the extension
   runs against `agentic-rc-1.70.0` instead of the production LSP, then run the auth spec.
   The full template for this is already written: `.github/workflows/poc-lsp-rc.yml` (the
   Windows E2E workflow) — adapt it for Linux (add the dnf-Xvfb step from fix #4) or flip the
   CodeBuild project to Windows.

Open dependencies before SSO will work: the auth Lambda ARN, the test SSO start URL/region,
and the IAM write for `lambda:InvokeFunction`. None of these are needed for the no-auth path
that's already green.

---

## 7. Quick reference — current file inventory

| File | Purpose |
|---|---|
| `.github/workflows/poc-lsp-rc-linux.yml` | no-auth handshake smoke (✅ green) |
| `.github/workflows/poc-e2e-linux.yml` | no-auth VS Code E2E, `test/e2e/lsp` (✅ green) |
| `.github/workflows/poc-lsp-rc.yml` | Windows full-E2E template (auth) — for §6 |
| `scripts/download-verify-rc.sh` / `.ps1` | download + SHA384-verify + unzip the RC |
| `smoke-handshake/handshake-smoke.mjs` | standalone LSP `initialize` check |
| `codebuild-runner-project.md` | AWS CLI/IAM to create the runner project |
