/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import { AuthUtil } from 'aws-core-vscode/codewhisperer'
import { registerAuthHook, using } from 'aws-core-vscode/test'
import { isSSOTestEnvironmentAvailable, loginToIdC } from './utils/setup'

/**
 * POC: the smallest possible authenticated E2E. It does ONLY the SSO login (via the
 * local-browser hook / auth Lambda) and asserts the connection is valid — no chat or
 * mynah-ui framework. Use this to validate the auth path end-to-end without the extra
 * surface (and flake/time) of the full chat spec.
 *
 * Run with TEST_FILE=test/e2e/amazonq/authOnly.test.ts.
 */
describe('Amazon Q Auth (POC, login only)', function () {
    this.timeout(300_000)

    it('logs in to IdC and reports connected', async function () {
        if (!isSSOTestEnvironmentAvailable()) {
            this.skip()
        }
        await using(registerAuthHook('amazonq-test-account'), async () => {
            await loginToIdC()
        })

        const authState = await AuthUtil.instance.getChatAuthState()
        assert.strictEqual(authState.amazonQ, 'connected', 'Amazon Q should be connected after loginToIdC()')
    })
})
