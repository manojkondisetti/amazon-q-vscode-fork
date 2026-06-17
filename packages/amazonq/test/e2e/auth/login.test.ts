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
 * - A fresh connection has no persisted region profile, and `connectToEnterpriseSso` does not
 *   auto-select one (`restoreRegionProfile` only restores a previously persisted selection), so
 *   we explicitly discover (`listRegionProfile`, a real backend call) and select the first
 *   profile (`switchRegionProfile`). This satisfies `requireProfileSelection()`, which otherwise
 *   keeps every feature at `pendingProfileSelection` instead of `connected`.
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

            // Discover and select a region profile (a fresh connection has none persisted, and
            // connectToEnterpriseSso does not auto-select). listRegionProfile is a real backend
            // call that succeeds only with a valid token.
            const profiles = await AuthUtil.instance.regionProfileManager.listRegionProfile()
            getLogger().info('[login-e2e] discovered %d region profile(s)', profiles.length)
            assert.ok(profiles.length > 0, 'Expected at least one Q Developer region profile')

            await AuthUtil.instance.regionProfileManager.switchRegionProfile(profiles[0], 'user')

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
