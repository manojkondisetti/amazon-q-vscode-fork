/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import { AuthUtil } from 'aws-core-vscode/codewhisperer'
import { registerStaticBearerToken, using } from 'aws-core-vscode/test'
import { isSSOTestEnvironmentAvailable, loginToIdC } from './utils/setup'

/**
 * POC: the smallest possible authenticated E2E. It establishes an IdC SSO connection but
 * supplies the bearer token directly from the `BEARER_TOKEN` repository secret instead of
 * driving the device-code browser login (which was flaky / failing in CI). No chat or
 * mynah-ui framework — use this to validate the auth path without the extra surface
 * (and flake/time) of the full chat spec.
 *
 * `loginToIdC()` still calls `connectToEnterpriseSso()`, which creates the SSO connection
 * (profile + scopes + cache key) in globalState; `registerStaticBearerToken()` stubs the
 * token provider so that connection's token is the injected one rather than a browser-minted
 * one. The token lives in memory only, so the assertion must run while the hook is active.
 *
 * Run with TEST_FILE=test/e2e/amazonq/authOnly.test.ts and BEARER_TOKEN set.
 */
describe('Amazon Q Auth (POC, login only)', function () {
    this.timeout(300_000)

    it('connects with a static bearer token and reports connected', async function () {
        if (!isSSOTestEnvironmentAvailable()) {
            this.skip()
        }
        await using(registerStaticBearerToken(), async () => {
            await loginToIdC()

            const authState = await AuthUtil.instance.getChatAuthState()
            assert.strictEqual(authState.amazonQ, 'connected', 'Amazon Q should be connected with BEARER_TOKEN')
        })
    })
})
