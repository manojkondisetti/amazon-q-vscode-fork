#!/usr/bin/env python3
"""
Headless IdC (IAM Identity Center) browser-login driver for amazon-q-vscode E2E auth.

This is the *browser-driving half* of Kiro's `IDCLoginBrowser`
(KiroBackendTests/src/main/java/com/amazon/kirobackendtests/auth/IDCLoginBrowser.java),
ported to Python + Playwright. It is a drop-in replacement for the auth Lambda that
`registerAuthHook` (packages/core/src/test/setupUtil.ts) normally invokes.

WHY this is so much smaller than the Kiro reference:
  Kiro mints its OWN token — it does the full PKCE flow itself (registerClient →
  /authorize → LocalAuthCodeReceiver → SsoOidcClient.createToken). We do NOT need any of
  that. The amazon-q EXTENSION already runs its own OIDC *device-code* flow when a test
  calls connectToEnterpriseSso(); registerAuthHook only exists to drive the browser
  approval step. So this script's only job is exactly Kiro's IDCLoginBrowser.login():
  open the verification URL, sign in, click Allow. The extension then polls the token
  endpoint and caches the bearer token itself (keyed by its own random connection UUID),
  which is the only place a cached token will actually be found again. See
  RUNBOOK-no-auth-e2e.md §6 / the auth addendum for the full rationale.

INPUT  : a device-flow verification URL (the extension's openExternal target, which looks
         like https://<tenant>.awsapps.com/start/#/device?user_code=ABCD-EFGH).
CREDS  : a Secrets Manager secret (default cred chain = the CodeBuild service role), in
         either Kiro format:  {"username": "...", "password": "..."}
         or multi-user:       {"users": {"<name>": {"password": "..."}}}
         (or pass --username/--password / IDC_USERNAME+IDC_PASSWORD for local testing).
OUTPUT : exit 0 once "Allow access" is clicked (device authorized); non-zero on any failure
         — a broken/oncorrect login MUST hard-fail so the gate actually gates.

Usage:
  # Secret as a full ARN — region is taken from the ARN (independent of the SSO region):
  idc-browser-login.py --url "<verificationUri>" \
      --secret-id arn:aws:secretsmanager:us-east-1:<acct>:secret:poc-username-password-y84myd
  # Secret as a bare name — supply its region explicitly:
  idc-browser-login.py --url "<verificationUri>" \
      --secret-id poc-username-password --secret-region us-east-1
  # local creds instead of Secrets Manager:
  idc-browser-login.py --url "<verificationUri>" --username u@example.com --password 'pw'

Selectors mirror IDCLoginBrowser.java verbatim (the IdC UI is Cloudscape / "awsui"):
  username  #awsui-input-0   →  button[type=submit]
  password  #awsui-input-1   →  button[type=submit]
  allow     button[data-testid=allow-access-button]  (fallback: text Allow/Authorize/Accept)
"""

from __future__ import annotations  # lazy annotations → run on Python 3.7+ (str|None, tuple[...])

import argparse
import json
import os
import re
import sys

# Timeouts kept WELL under the test harness's 300s per-test cap (setupUtil.setRunnableTimeout)
# and the hook's 240s execFileSync timeout, so a single slow wait can't blow the budget.
NAV_TIMEOUT_MS = 60_000
STEP_TIMEOUT_MS = 30_000


# Mirror every log line to a file too, so output survives even if the caller kills us
# (execFileSync buffers stdout/stderr until exit; a killed process loses it). The workflow
# uploads .test-reports/ as an artifact, so point IDC_LOG_FILE there.
_LOG_FILE = os.environ.get("IDC_LOG_FILE")


def log(msg: str) -> None:
    line = f"[idc-browser-login] {msg}"
    print(line, file=sys.stderr, flush=True)
    if _LOG_FILE:
        try:
            with open(_LOG_FILE, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:  # noqa: BLE001
            pass


def _region_from_arn(secret_id: str) -> str | None:
    """Extract the region from a full Secrets Manager ARN, else None (it's a bare name)."""
    # arn:aws:secretsmanager:<region>:<account>:secret:<name>-<suffix>
    parts = secret_id.split(":")
    if len(parts) >= 4 and parts[0] == "arn" and parts[2] == "secretsmanager":
        return parts[3]
    return None


def resolve_credentials(args) -> tuple[str, str]:
    """Username/password from explicit args, env, or Secrets Manager (Kiro formats)."""
    username = args.username or os.environ.get("IDC_USERNAME")
    password = args.password or os.environ.get("IDC_PASSWORD")
    if username and password:
        log("Using credentials from args/env (no Secrets Manager call).")
        return username, password

    if not args.secret_id:
        sys.exit("No credentials: pass --username/--password, set IDC_USERNAME/IDC_PASSWORD, "
                 "or pass --secret-id.")

    # boto3 only needed on the Secrets Manager path; keep it an optional import.
    import boto3  # noqa: WPS433 (intentional local import)

    # The secret's region is INDEPENDENT of the SSO region (the secret can live in a
    # different region than the IdC tenant). Resolve it as: region embedded in a full ARN →
    # --secret-region / SECRET_REGION → finally TEST_SSO_REGION as a last resort.
    secret_region = _region_from_arn(args.secret_id) or args.secret_region
    if not secret_region:
        sys.exit("Cannot determine the secret's region: pass a full secret ARN, or set "
                 "--secret-region / SECRET_REGION.")

    log(f"Fetching credentials from Secrets Manager: {args.secret_id} ({secret_region})")
    client = boto3.client("secretsmanager", region_name=secret_region)
    secret_string = client.get_secret_value(SecretId=args.secret_id)["SecretString"]
    data = json.loads(secret_string)

    # parseCredentials vs parseCredentialsForUser (SecretsManagerCredentialsProvider.java).
    if "users" in data:
        if not username:
            sys.exit("Secret is multi-user ({\"users\":{...}}) — pass --username to pick one.")
        user_node = data["users"].get(username)
        if not user_node:
            sys.exit(f"User '{username}' not found in multi-user secret.")
        return username, user_node["password"]

    return data["username"], data["password"]


def drive_login(url: str, username: str, password: str, headed: bool = False,
                dump_html: str | None = None) -> None:
    from playwright.sync_api import TimeoutError as PWTimeout, sync_playwright

    with sync_playwright() as p:
        # Chromium. headless by default; --headed for local debugging (watch the page live).
        # --no-sandbox: the CodeBuild runner is an unprivileged container, same constraint
        # that made fix #4 (Xvfb) necessary in the runbook.
        browser = p.chromium.launch(headless=not headed, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_default_timeout(STEP_TIMEOUT_MS)
        page.set_default_navigation_timeout(NAV_TIMEOUT_MS)

        def maybe_dump(tag: str) -> None:
            if dump_html:
                path = f"{dump_html}.{tag}.html"
                try:
                    with open(path, "w", encoding="utf-8") as fh:
                        fh.write(page.content())
                    log(f"Wrote page HTML: {path}")
                except Exception as e:  # noqa: BLE001
                    log(f"Could not write {path}: {e}")

        try:
            log(f"Navigating to verification URL: {url.split('?')[0]}?…")
            page.goto(url, wait_until="domcontentloaded")
            maybe_dump("0-landing")

            # Step 0 (device-code flow only): the "Confirm and continue" / "Verify" page.
            # Because the extension passes ?user_code=XXXX-XXXX the code is pre-filled, so we
            # just confirm. Best-effort: skip silently if this page isn't shown.
            # NOTE: Playwright's name= accepts a str or re.Pattern only — NOT a callable.
            # Keep this regex narrow: the device-confirm button is "Confirm and continue" /
            # "Verify". Do NOT match "Next"/"Allow" here, or it could eat the username page's
            # submit before we type the username.
            try:
                confirm = page.get_by_role(
                    "button", name=re.compile(r"Confirm|Continue|Verify", re.I)
                )
                confirm.first.click(timeout=15_000)
                log("Clicked device-code confirm/continue.")
            except PWTimeout:
                log("No device-code confirm page (or already past it); continuing.")
            _dump_state(page, "after device-code confirm")

            # The IdC sign-in (signin.aws/platform) is a React/awsui multi-step form:
            #   page 1: username  (#awsui-input-0) → "Next"
            #   page 2: password  (#awsui-input-1) → "Sign in"
            # awsui inputs are React-controlled: page.fill() sets .value but may not fire the
            # state update that enables the submit button, so we type real key events and
            # click the button BY ITS TEXT (Next / Sign in), not a generic type=submit.
            log("Entering username.")
            _type_into(page, "#awsui-input-0", username)
            maybe_dump("1-username-page")
            _click_button(page, r"Next|Continue")
            page.wait_for_timeout(3_000)
            _dump_state(page, "after username submit")

            # Step 2: password (a NEW page; field is #awsui-input-1, type=password).
            log("Entering password.")
            _type_into(page, "input[type=password]", password)
            maybe_dump("2-password-page")
            _click_button(page, r"Sign in|Submit|Log in")
            page.wait_for_timeout(4_000)
            _dump_state(page, "after password submit")
            maybe_dump("3-after-password")

            # Step 3: authorization "Allow access". May be absent on a re-auth where the
            # grant is remembered — mirror IDCLoginBrowser and don't fail if it's missing.
            _dump_state(page, "before allow step")
            maybe_dump("4-allow-page")
            log("Looking for Allow/Authorize button.")
            clicked = _click_allow(page)
            if clicked:
                log("Clicked Allow — device authorized.")
            else:
                log("Allow button not found — assuming grant already remembered; continuing.")

            # Give the redirect that completes the device flow a moment to fire.
            page.wait_for_timeout(5_000)
            final = page.url
            if any(bad in final for bad in ("signin", "login", "error")):
                # Surface state for debugging, then hard-fail — a stuck login is a real failure.
                _dump_state(page, "STUCK on login/error page")
                log(f"Still on a login/error page after Allow: {final}")
                sys.exit("IdC login did not complete (stuck on sign-in/error page).")
            log("Login flow complete.")
        finally:
            browser.close()


def _dump_state(page, where: str) -> None:
    """Log url + title + visible alert/error text so CI stderr shows what the page is.

    IdC renders auth failures and MFA prompts as visible text (e.g. 'Your authentication
    information is incorrect', 'Multi-factor authentication'), which disambiguates a stuck
    login (bad creds vs MFA vs wrong selector) without a screenshot.
    """
    try:
        title = page.title()
    except Exception:  # noqa: BLE001
        title = "<unavailable>"
    log(f"[{where}] url={page.url} title={title!r}")
    # Surface any visible error/alert text. IdC renders auth failures as plain text (e.g.
    # "Something doesn't compute / We couldn't verify your sign-in credentials") — not a
    # [role=alert] — and MFA as "verification code", so match on the body text too.
    patterns = re.compile(
        r"couldn't verify|doesn't compute|incorrect|invalid|wrong password|"
        r"authentication failed|try again|multi-factor|verification code|expired",
        re.I,
    )
    try:
        body = (page.locator("body").inner_text(timeout=3_000) or "")
        hits = {m.group(0) for m in patterns.finditer(body)}
        if hits:
            # Pull a short readable line around the first hit for context.
            idx = body.lower().find(next(iter(hits)).lower())
            snippet = re.sub(r"\s+", " ", body[max(0, idx - 120): idx + 120]).strip()
            log(f"[{where}] page message: …{snippet}…")
    except Exception:  # noqa: BLE001
        pass


def _type_into(page, selector: str, value: str) -> None:
    """Type real key events into an awsui (React-controlled) input.

    page.fill() sets .value directly, which awsui's React state often does not observe, so
    the submit button stays disabled/inert. click()+press_sequentially() fires the focus +
    input + keydown events the component listens for.
    """
    loc = page.locator(selector).first
    loc.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
    loc.click()
    loc.fill("")  # clear any prefill
    loc.press_sequentially(value, delay=15)
    log(f"Typed into {selector}.")


def _click_button(page, name_regex: str) -> None:
    """Click an awsui button by its visible text (Next / Sign in), with a type=submit fallback."""
    try:
        page.get_by_role("button", name=re.compile(name_regex, re.I)).first.click(timeout=15_000)
        log(f"Clicked button matching /{name_regex}/.")
        return
    except Exception:  # noqa: BLE001
        page.click("button[type=submit]", timeout=15_000)
        log("Clicked button[type=submit] (text match failed).")


def _click_allow(page) -> bool:
    """IDCLoginBrowser's layered fallback: testid → role+name regex."""
    try:
        page.click("button[data-testid=allow-access-button]", timeout=30_000)
        return True
    except Exception:  # noqa: BLE001 — any miss falls through to the text fallback
        pass
    try:
        page.get_by_role(
            "button", name=re.compile(r"Allow access|Allow|Authorize|Accept", re.I)
        ).first.click(timeout=10_000)
        return True
    except Exception:  # noqa: BLE001
        return False


def main() -> None:
    ap = argparse.ArgumentParser(description="Headless IdC browser login for amazon-q E2E.")
    ap.add_argument("--url", required=True, help="Device-flow verification URL (openExternal target).")
    ap.add_argument("--secret-id", default=os.environ.get("AMAZONQ_TEST_SECRET"),
                    help="Secrets Manager secret id/ARN holding {username,password}. "
                         "Pass a full ARN to carry its region; the secret region is "
                         "independent of the SSO region.")
    ap.add_argument("--secret-region", default=os.environ.get("SECRET_REGION"),
                    help="Region of the Secrets Manager secret, if --secret-id is a bare "
                         "name (a full ARN supplies it automatically).")
    ap.add_argument("--username", default=None, help="Override / pick a user (multi-user secret).")
    ap.add_argument("--password", default=None, help="Override password (skips Secrets Manager).")
    ap.add_argument("--headed", action="store_true",
                    help="Run the browser headed (local debugging — watch the page live).")
    ap.add_argument("--dump-html", default=None, metavar="PREFIX",
                    help="Write page HTML at each step to <PREFIX>.<step>.html (selector debugging).")
    args = ap.parse_args()

    username, password = resolve_credentials(args)
    drive_login(args.url, username, password, headed=args.headed, dump_html=args.dump_html)


if __name__ == "__main__":
    main()
