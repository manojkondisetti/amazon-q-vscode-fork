/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import { AuthUtil } from 'aws-core-vscode/codewhisperer'
import { registerAuthHook, using } from 'aws-core-vscode/test'
import { getLogger } from 'aws-core-vscode/shared'
import { loginToIdC, isSSOTestEnvironmentAvailable } from '../amazonq/utils/setup'

/**
 * The first E2E test: perform a REAL IdC SSO login (mirroring the actual user "click login"
 * flow and Kiro's IDEUserLoginTest), then assert the extension reports a connected Amazon Q
 * connection with a selected region profile.
 *
 * How auth works here (no static token, no auth Lambda):
 * - `loginToIdC()` calls `AuthUtil.connectToEnterpriseSso(startUrl, region)`, which runs the
 *   extension's own device-code OAuth flow. The extension mints + caches a REAL, refreshable
 *   token itself (correctly keyed by its connection id — the only place it can be found again).
 * - `registerAuthHook('amazonq-test-account')` with `AUTH_UTIL_LOCAL_BROWSER=1` drives the
 *   browser approval locally via a headless Playwright script (poc-artifacts/scripts/
 *   idc-browser-login.py), using the USER_NAME / PASSWORD credentials. No Lambda, no Secrets
 *   Manager, no AWS credentials.
 * `loginToIdC()` performs the login AND selects a region profile (a fresh connection has none,
 * and `connectToEnterpriseSso` does not auto-select one); without a selected profile
 * `requireProfileSelection()` keeps every feature at `pendingProfileSelection` instead of
 * `connected`. This spec just asserts the resulting state.
 *
 * Requires TEST_SSO_STARTURL / TEST_SSO_REGION (to ungate + build the connection) and, in CI,
 * USER_NAME / PASSWORD + AUTH_UTIL_LOCAL_BROWSER for the local browser driver.
 */
describe('Amazon Q Login', function () {
    this.timeout(300_000)

    it('logs in via IdC SSO and reports a connected, profile-selected Amazon Q connection', async function () {
        if (!isSSOTestEnvironmentAvailable()) {
            this.skip()
        }

        await using(registerAuthHook('amazonq-test-account'), async () => {
            await loginToIdC()

            const authState = await AuthUtil.instance.getChatAuthState()
            const profile = AuthUtil.instance.regionProfileManager.activeRegionProfile
            getLogger().info(
                '[login-e2e] amazonQ=%s | activeRegionProfile=%O | chatAuthState=%O',
                authState.amazonQ,
                profile,
                authState
            )
            // eslint-disable-next-line aws-toolkits/no-console-log
            console.log(
                `[login-e2e] amazonQ=${authState.amazonQ} profileRegion=${profile?.region ?? 'none'} profileArn=${profile?.arn ?? 'none'}`
            )

            assert.strictEqual(authState.amazonQ, 'connected', 'Amazon Q should be connected after login')
            assert.ok(profile !== undefined, 'A region profile should be selected after login')
        })
    })
})
