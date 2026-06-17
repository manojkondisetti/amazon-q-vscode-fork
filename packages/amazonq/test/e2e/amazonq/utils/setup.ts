/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { AuthUtil } from 'aws-core-vscode/codewhisperer'

/**
 * Returns true if the SSO auth infrastructure required for E2E tests is available.
 *
 * These tests require an internal SSO identity provider and a Lambda-based auth
 * hook that automates the browser login flow. This infrastructure is only available
 * in internal CI (CodeBuild) and cannot be replicated in GitHub Actions.
 */
export function isSSOTestEnvironmentAvailable(): boolean {
    return !!process.env['TEST_SSO_STARTURL'] && !!process.env['TEST_SSO_REGION']
}

export async function loginToIdC() {
    const authState = await AuthUtil.instance.getChatAuthState()
    if (process.env['AWS_TOOLKIT_AUTOMATION'] === 'local') {
        if (authState.amazonQ !== 'connected') {
            throw new Error('You will need to login manually before running tests.')
        }
        return
    }

    const startUrl = process.env['TEST_SSO_STARTURL']
    const region = process.env['TEST_SSO_REGION']

    if (!startUrl || !region) {
        throw new Error(
            'TEST_SSO_STARTURL and TEST_SSO_REGION are required environment variables when running Amazon Q E2E tests'
        )
    }

    await AuthUtil.instance.connectToEnterpriseSso(startUrl, region)
    await selectRegionProfile()
}

/**
 * A freshly-created IdC connection has no region profile selected, and `connectToEnterpriseSso`
 * does not auto-select one (`restoreRegionProfile` only restores a previously persisted choice,
 * and the test harness clears globalState between tests). Without a selected profile,
 * `requireProfileSelection()` keeps every Amazon Q feature at `pendingProfileSelection` instead
 * of `connected`, so completions never resolve an endpoint.
 *
 * Discover the available profiles (a real backend call that only succeeds with a valid token)
 * and select the first one, so every e2e spec that logs in ends up fully connected. Idempotent:
 * skips if a profile is already active.
 */
async function selectRegionProfile() {
    const profileManager = AuthUtil.instance.regionProfileManager
    if (profileManager.activeRegionProfile !== undefined) {
        return
    }
    const profiles = await profileManager.listRegionProfile()
    if (profiles.length === 0) {
        throw new Error('No Q Developer region profiles available for the test user')
    }
    await profileManager.switchRegionProfile(profiles[0], 'user')
}
