# Handoff — authenticated amazonq E2E via local-browser auth (no Lambda)

**Status (2026-06-16): 95% done. The hard part — driving IdC login in a headless browser —
is PROVEN WORKING. One open issue remains: a browser-authorized device does not yield a
`connected` extension state.** This doc is the complete state so the next person resumes
deliberately rather than re-deriving 18 CI runs.

## Goal

Run an authenticated amazonq E2E spec on the CodeBuild Linux runner with **no auth Lambda**
(and no `lambda:InvokeFunction` IAM) — replacing the Lambda that `registerAuthHook` normally
invokes with a local headless-browser driver, modeled on Kiro's `KiroBackendTests`
(`auth/IDCLoginBrowser.java`, which uses no Lambda either). See `RUNBOOK-no-auth-e2e.md`
§6-auth for the design and why pure SSO-cache pre-seeding can't work.

## What is PROVEN working (do not re-investigate)

The full chain runs green up to the very last step. Evidence: run 17/18 driver log
(`/tmp/idc-diag/idc-browser-login.log` in the run artifact):

1. CodeBuild runner picks up the job; build + Python/Playwright install + Xvfb all succeed.
2. The `setupUtil.ts` hook (env-gated `AUTH_UTIL_LOCAL_BROWSER`) fires, **eagerly stubbing
   `vscode.env.openExternal` AND clicking the "Proceed To Browser" modal** — both are
   required (the device-code flow shows a *progress* notification, not the old modal button).
3. The driver (`scripts/idc-browser-login.py`) drives the **real** `signin.aws/platform`
   login: username (`#awsui-input-0`) → "Next" → password (`input[type=password]`) →
   "Sign in" → lands back on the device page with the real `user_code` → "Confirm and
   continue" → "Allow" → logs **"Device authorization approved — login flow complete."**
4. Driver exits 0. Validated **locally** too (headed Playwright against the real tenant).

## THE ONE OPEN ISSUE

After the driver provably authorizes the device, `AuthUtil.instance.getChatAuthState()`
still returns **`disconnected`** (runs 17 & 18, minimal `authOnly.test.ts`, fails in ~42s
with `AssertionError: Amazon Q should be connected`).

- Run 18 confirmed it is **NOT** an event-loop-block issue: the driver now runs async
  (`spawn`, not `execFileSync`), the extension host stays responsive, the token poll runs
  concurrently — yet still `disconnected`.
- The 42s fail (not the 300s timeout) means `connectToEnterpriseSso()` **returned** (didn't
  hang) — but to a disconnected state. It likely either threw an error `loginToIdC` swallowed,
  or the token was obtained but the connection wasn't marked valid.
- **No extension auth logging appears in CI stdout** — the toolkit logs to its own output
  channel, which the test reporter doesn't capture. That's the missing visibility.

### Leading hypotheses (for the next investigator)

1. **Device-code mismatch.** The extension's `startDeviceAuthorization` mints device code A
   and calls `openExternal(verificationUri?user_code=A)`. The driver authorizes whatever URL
   it's handed — confirm it's authorizing code A, not a stale/second authorization. Check
   whether `connectToEnterpriseSso` triggers more than one `openExternal`.
2. **Poll gave up / errored silently.** `pollForTokenWithProgress`
   (`packages/core/src/auth/sso/ssoAccessTokenProvider.ts`) polls `createToken`. If it hit
   `InvalidGrantException`/expiry it would throw — verify whether `loginToIdC`/the spec
   swallows it. (The spec does `await using(registerAuthHook(...), () => loginToIdC())`.)
3. **Token cached but connection not activated.** Recall the original finding
   (`brain/references/amazon-q-vscode-e2e-auth.md`): connection state lives in VS Code
   globalState keyed by a random UUID; `isConnected() => this.conn !== undefined`. The token
   may land in `~/.aws/sso/cache` but the `secondaryAuth`/`AuthUtil` connection isn't set
   active.

### The precise next step (chosen approach: capture extension auth logs)

Add a single diagnostic run that surfaces the extension's OWN logs:
- Set the toolkit log level to debug (env `AWS_TOOLKIT_..._LOGLEVEL` or the
  `aws.logLevel` setting; check `packages/core/src/shared/logger`), and capture its output
  channel to a file under `/tmp/idc-diag/`.
- Dump `~/.aws/sso/cache/` contents (filenames + whether a token json exists) after
  `loginToIdC()` returns — proves whether a token was minted at all.
- Catch + log the error from `connectToEnterpriseSso` explicitly in `authOnly.test.ts`
  (wrap in try/catch, log `e.message`/`e.stack`) so a swallowed rejection becomes visible.

That single run should reveal which of the three hypotheses is true.

## Artifacts & where things live

**Fork:** `manojkondisetti/amazon-q-vscode-fork`, branch **`poc-auth-localbrowser`**
(branched from `poc-lsp-rc`). Local clone: `/Volumes/workplace/vscode-fork/amazon-q-vscode-fork`.
The workflow file is also on `main` (indexing requirement).

| File | Role |
|---|---|
| `packages/core/src/test/setupUtil.ts` | The hook patch: `runLocalBrowserLogin` (async spawn) + eager `openExternal` stub + modal click, env-gated on `AUTH_UTIL_LOCAL_BROWSER`. Lambda path unchanged. |
| `poc-artifacts/scripts/idc-browser-login.py` | The Playwright driver (PROVEN). `--url --secret-id [--secret-region --username --password --headed --dump-html --log-file]`. |
| `packages/amazonq/test/e2e/amazonq/authOnly.test.ts` | Minimal login-only spec — use this to iterate (fast, ~12 min, no chat surface). |
| `.github/workflows/poc-e2e-auth-linux.yml` | The CI workflow. Uploads `/tmp/idc-diag/` + `/tmp/xvfb.log` as artifact. |
| `poc-artifacts/auth-secret-setup.md` | Secret + IAM setup (done). |
| `~/workplace/brain/references/amazon-q-vscode-e2e-auth.md` | The cache-key/globalState findings. |

**Config (all set):** GitHub repo Variables `POC_CODEBUILD_PROJECT=VSCode-test-poc`,
`TEST_SSO_STARTURL=https://d-9267f5fbb0.awsapps.com/start`, `TEST_SSO_REGION=us-west-2`,
`AMAZONQ_TEST_SECRET=arn:aws:secretsmanager:us-east-1:876778438035:secret:poc-username-password-y84myd`.
CodeBuild role `codebuild-VSCode-test-poc-service-role` has `SecretsManagerReadWrite`
(broader than needed — tighten to `GetSecretValue` on the one ARN before any real use).
Secret holds `{username,password}` (manually verified to log in).

## How to run

```bash
gh workflow run poc-e2e-auth-linux.yml --repo manojkondisetti/amazon-q-vscode-fork \
  --ref poc-auth-localbrowser -f test_file=test/e2e/amazonq/authOnly.test.ts -f reason="…"
# watch is flaky; poll instead:
gh run view <id> --repo manojkondisetti/amazon-q-vscode-fork --json status,conclusion
gh run download <id> --repo manojkondisetti/amazon-q-vscode-fork --dir /tmp/runN
cat /tmp/runN/*/tmp/idc-diag/idc-browser-login.log   # driver trace
```

**Local driver iteration (seconds, no CI):** install Playwright, then
`python3 poc-artifacts/scripts/idc-browser-login.py --headed --dump-html /tmp/idc
--url "https://d-9267f5fbb0.awsapps.com/start" --username <u> --password <p>` — proven to
drive the real login.

## Key gotchas learned (so they aren't re-hit)

- `TEST_FILE` is **package-relative** (resolved vs `packages/amazonq/dist/`, `.ts→.js`):
  use `test/e2e/amazonq/authOnly.test.ts`, not the full path.
- Extension host gets a **curated env** — job-level `IDC_*` env vars don't reach the driver;
  the hook passes everything via CLI flags instead.
- Driver logs to **stderr** + `--log-file` (not stdout).
- Diagnostics must go to **`/tmp/idc-diag/`** (absolute) — a relative `.test-reports/` was
  never captured by the artifact upload.
- Never block the event loop in the `openExternal` stub (`spawn`, not `execFileSync`) — the
  token poll shares the loop.
- `gh run watch` disconnects early on these long runs; poll `gh run view --json status`.
- Read pass/fail from the **GitHub Actions UI**, never CodeBuild (it reports "Succeeded" if
  the runner merely started).

## Run history (each fixed a real, distinct bug)

1 TS compile error · 2 bare secret name vs ARN · 3 swallowed output · 4 wrong script path ·
5 Playwright `name=lambda` · 6–7 login not submitting (React awsui needs real key events +
text buttons) · 8 wrong creds in secret · 9 creds fixed, login succeeds · 10–12 driver logs
invisible (curated env / cwd / stdout-vs-stderr) · 13 hook matched the wrong message variant ·
14 modal not clicked · 15 device-auth page needs Confirm+Allow · 16 1h hang (`bash -c` orphan
pipe) · 17 device authorized but disconnected · 18 async fix (loop no longer blocked) — still
disconnected → **the open issue above.**
