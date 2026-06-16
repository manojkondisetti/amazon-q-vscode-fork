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
import sys

# Match IDCLoginBrowser's 5-minute page budget; IdC redirects can be slow.
NAV_TIMEOUT_MS = 300_000
STEP_TIMEOUT_MS = 60_000


def log(msg: str) -> None:
    # Stderr so it never pollutes anything a caller might parse on stdout.
    print(f"[idc-browser-login] {msg}", file=sys.stderr, flush=True)


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


def drive_login(url: str, username: str, password: str) -> None:
    from playwright.sync_api import TimeoutError as PWTimeout, sync_playwright

    with sync_playwright() as p:
        # Chromium headless. --no-sandbox: the CodeBuild runner is an unprivileged
        # container, same constraint that made fix #4 (Xvfb) necessary in the runbook.
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_default_timeout(STEP_TIMEOUT_MS)
        page.set_default_navigation_timeout(NAV_TIMEOUT_MS)
        try:
            log(f"Navigating to verification URL: {url.split('?')[0]}?…")
            page.goto(url, wait_until="domcontentloaded")

            # Step 0 (device-code flow only): the "Confirm and continue" / "Verify" page.
            # Because the extension passes ?user_code=XXXX-XXXX the code is pre-filled, so we
            # just confirm. Best-effort: skip silently if this page isn't shown.
            try:
                confirm = page.get_by_role(
                    "button", name=lambda n: bool(n) and any(
                        k in n for k in ("Confirm", "Continue", "Verify", "Next")
                    ),
                )
                confirm.first.click(timeout=15_000)
                log("Clicked device-code confirm/continue.")
            except PWTimeout:
                log("No device-code confirm page (or already past it); continuing.")

            # Step 1: username  (IDCLoginBrowser: #awsui-input-0 → submit)
            log("Entering username.")
            page.fill("#awsui-input-0", username, timeout=STEP_TIMEOUT_MS)
            page.click("button[type=submit]")

            # Step 2: password  (#awsui-input-1 → submit)
            log("Entering password.")
            page.fill("#awsui-input-1", password, timeout=STEP_TIMEOUT_MS)
            page.click("button[type=submit]")

            # Step 3: authorization "Allow access". May be absent on a re-auth where the
            # grant is remembered — mirror IDCLoginBrowser and don't fail if it's missing.
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
                log(f"Still on a login/error page after Allow: {final}")
                sys.exit("IdC login did not complete (stuck on sign-in/error page).")
            log("Login flow complete.")
        finally:
            browser.close()


def _click_allow(page) -> bool:
    """IDCLoginBrowser's layered fallback: testid → text → scan all buttons."""
    from playwright.sync_api import TimeoutError as PWTimeout

    try:
        page.click("button[data-testid=allow-access-button]", timeout=30_000)
        return True
    except PWTimeout:
        pass
    for label in ("Allow access", "Allow", "Authorize", "Accept"):
        try:
            page.get_by_role("button", name=label).first.click(timeout=5_000)
            return True
        except PWTimeout:
            continue
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
    args = ap.parse_args()

    username, password = resolve_credentials(args)
    drive_login(args.url, username, password)


if __name__ == "__main__":
    main()
