/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { parse } from '@aws-sdk/util-arn-parser'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import * as vscode from 'vscode'
import { getLogger } from '../shared/logger'
import { hasKey } from '../shared/utilities/tsUtils'
import { getTestWindow, printPendingUiElements } from './shared/vscode/window'
import { ToolkitError, formatError } from '../shared/errors'
import { proceedToBrowser } from '../auth/sso/model'
import { decodeBase64 } from '../shared'

const runnableTimeout = Symbol('runnableTimeout')

/**
 * Wraps the test function to bubble up errors that occurred in events from `TestWindow`
 */
export function setRunnableTimeout(test: Mocha.Runnable, maxTestDuration: number): Mocha.Runnable {
    const testFn = test.fn
    if (!testFn) {
        return test
    }

    // The timeout duration is stored within the function itself, allowing
    // us to know if we've already added a timeout
    if (!hasKey(testFn, runnableTimeout)) {
        const fn = function (this: Mocha.Context, done: Mocha.Done) {
            const maxTestDuration = (fn as any)[runnableTimeout] as number

            return Promise.race([
                testFn.call(this, done),
                new Promise<void>((_, reject) => {
                    getTestWindow().onError(({ event, error }) => {
                        event.dispose()
                        reject(error)
                    })

                    // Set a hard time limit per-test so CI doesn't hang
                    // Mocha's `timeout` method isn't used because we want to emit a custom message
                    setTimeout(() => {
                        const duration = `${maxTestDuration / 1000} seconds`
                        const message = `Test length exceeded max duration: ${duration}\n${printPendingUiElements()}`
                        reject(new Error(message))
                    }, maxTestDuration)
                }),
            ])
        }

        test.fn = fn
    }

    Object.assign(test.fn!, { [runnableTimeout]: Math.max(maxTestDuration, test.timeout()) })

    return test
}

export function skipTest(testOrCtx: Mocha.Context | Mocha.Test | undefined, reason?: string) {
    let test

    if (testOrCtx?.type === 'test') {
        test = testOrCtx as Mocha.Test
    } else {
        const context = testOrCtx as Mocha.Context | undefined
        test = context?.currentTest ?? context?.test
    }

    if (test) {
        test.title += ` (skipped${reason ? ` - ${reason}` : ''})`
        test.skip()
    }
}

export function skipSuite(suite: Mocha.Suite, reason?: string) {
    suite.eachTest((test) => skipTest(test, reason))
}

export function mapTestErrors(runner: Mocha.Runner, fn: (err: unknown, test: Mocha.Test) => any) {
    return runner.prependListener('fail', (test, err) => {
        test.err = fn(err, test) || err
    })
}

/**
 * Formats any known sub-classes of {@link Error} for better compatability with test reporters.
 *
 * Most test reporters will only output the name + message + stack trace so any relevant
 * info must go into those fields.
 */
export function normalizeError(err?: unknown) {
    if (err instanceof ToolkitError) {
        // Error has to be mutated to show up in the report:
        // https://github.com/michaelleeallen/mocha-junit-reporter/blob/4b17772f8da33d580fafa4d124e5c11142a70c1f/index.js#L262
        //
        // We'll just patch the message/stack trace even though it's arguably incorrect (and looks kind of ugly)
        // Once `cause` is more common in the JS ecosystem we'll start to see support from test reporters

        return Object.assign(err, {
            message: formatError(err).replace(`${err.name}: `, ''),
            stack: err.stack?.replace(err.message, err.trace.replace(`${err.name}: `, '') + '\n'),
        })
    }

    return err
}

export function patchObject<T extends Record<string, any>, U extends keyof T>(
    obj: T,
    key: U,
    value: T[U]
): vscode.Disposable {
    return patchObjectDescriptor(obj, key, { value })
}

export function patchObjectDescriptor<T extends Record<string, any>, U extends keyof T>(
    obj: T,
    key: U,
    descriptor: TypedPropertyDescriptor<T[U]>
): vscode.Disposable {
    const original = Object.getOwnPropertyDescriptor(obj, key)
    Object.defineProperty(obj, key, descriptor)

    function dispose() {
        if (original === undefined) {
            delete obj[key]
        } else {
            Object.defineProperty(obj, key, original)
        }
    }

    return { dispose }
}

async function createLambdaClient(functionId: string) {
    if (!functionId.startsWith('arn:aws:lambda')) {
        return Object.assign(new LambdaClient({}), { isCrossAccount: false })
    }

    const sts = new STSClient({})
    const { region, accountId } = parse(functionId)
    const identity = await sts.send(new GetCallerIdentityCommand({}))
    const client = new LambdaClient({ region })

    return Object.assign(client, { isCrossAccount: identity.Account !== accountId })
}

export async function invokeLambda(id: string, request: unknown): Promise<unknown> {
    const client = await createLambdaClient(id)
    const response = await client
        .send(
            new InvokeCommand({
                FunctionName: id,
                // Setting this to `Tail` with cross account calls results in
                // `AccessDeniedException: Cross-account log access is not allowed`
                LogType: client.isCrossAccount ? 'None' : 'Tail',
                Payload: JSON.stringify(request),
            })
        )
        .catch((err) => {
            if (err instanceof Error) {
                err.message = maskArns(err.message)
            }
            throw err
        })

    if (response.LogResult) {
        const logs = decodeBase64(response.LogResult)
        getLogger().debug('lambda invocation logs: %s', maskArns(logs))
    } else {
        getLogger().debug('lambda invocation request id: %s', response.$metadata?.requestId)
    }

    const respStr = response.Payload ? new TextDecoder().decode(response.Payload) : undefined
    if (!respStr || respStr === 'null') {
        return
    }

    const respPayload = JSON.parse(respStr)
    if (response.FunctionError) {
        const error = new Error()
        error.name = respPayload.errorType || error.name
        error.message = maskArns(respPayload.errorMessage || error.message)

        throw error
    }

    return respPayload
}

function maskArns(text: string) {
    return text.replace(/arn:(aws|aws-cn|aws-us-gov):(?:.*?):(.*?):(.*?):./g, (match, region, account) => {
        if (region) {
            match = match.replace(region, '[omitted]')
        }
        if (account) {
            match = match.replace(account, '[omitted]')
        }

        return match
    })
}

/**
 * Drives the real SSO device-code browser approval LOCALLY (no auth Lambda) via a headless
 * Playwright script (poc-artifacts/scripts/idc-browser-login.py). This mimics a genuine user
 * login: the extension runs its own device-code flow, mints a real refreshable token, and
 * caches it itself (correctly keyed) — the only injection seam is what drives the browser.
 *
 * Credentials come from the `USER_NAME` / `PASSWORD` env vars (sourced from GitHub secrets);
 * no Secrets Manager / AWS credentials are required.
 */
function runLocalBrowserLogin(urlString: string): Promise<void> {
    const { spawn } = require('child_process') as typeof import('child_process')
    const fs2 = require('fs') as typeof import('fs')
    const script = process.env['AUTH_UTIL_LOCAL_BROWSER_SCRIPT'] ?? 'poc-artifacts/scripts/idc-browser-login.py'
    // Keep the full URL (incl. user_code) — the Playwright driver handles the confirm page.
    const localArgs = ['--url', urlString]
    // Credentials from env (GitHub secrets USER_NAME / PASSWORD). The driver also accepts
    // IDC_USERNAME / IDC_PASSWORD; pass whichever is set so local runs work too.
    const username = process.env['USER_NAME'] ?? process.env['IDC_USERNAME']
    const password = process.env['PASSWORD'] ?? process.env['IDC_PASSWORD']
    if (username) {
        localArgs.push('--username', username)
    }
    if (password) {
        localArgs.push('--password', password)
    }
    // Diagnostics → /tmp (absolute, cwd-independent) so the artifact upload reliably captures them.
    const outDir = '/tmp/idc-diag'
    try {
        fs2.mkdirSync(outDir, { recursive: true })
    } catch {
        // ignore
    }
    localArgs.push('--dump-html', `${outDir}/idc-page`)
    // The driver writes its own log file (independent of pipes), so the trace survives even if
    // we SIGKILL it on timeout.
    localArgs.push('--log-file', `${outDir}/idc-browser-login.log`)
    // CRITICAL: run ASYNC (spawn, not execFileSync). The browser approval must happen
    // CONCURRENTLY with the extension's device-code token poll — both share this Node event
    // loop. A blocking call freezes the poll so it never sees the authorization. Awaiting a
    // spawned child yields the loop.
    return new Promise<void>((resolve, reject) => {
        const child = spawn('python3', [script, ...localArgs], { stdio: ['ignore', 'pipe', 'pipe'] })
        const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
        let stderr = ''
        child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
        child.on('error', (err: Error) => {
            clearTimeout(timer)
            reject(err)
        })
        child.on('close', (code: number | null) => {
            clearTimeout(timer)
            if (code === 0) {
                getLogger().info('idc-browser-login completed; see %s', `${outDir}/idc-browser-login.log`)
                resolve()
            } else {
                reject(new Error(`idc-browser-login failed (exit ${code}):\n${stderr}`))
            }
        })
    })
}

/**
 * Registers a hook to proxy SSO logins to a Lambda function.
 *
 * The function is expected to perform a browser login using the following parameters:
 * * `secret` - a SecretsManager secret containing login credentials.
 * * `userCode` - the user verification code e.g. `ABCD-EFGH`. This is returned by the device authorization flow.
 * * `verificationUri` - the url to login with. This is returned by the device authorization flow.
 *
 * When `AUTH_UTIL_LOCAL_BROWSER` is set, the browser approval is driven LOCALLY by a headless
 * Playwright script instead of the auth Lambda (see {@link runLocalBrowserLogin}). The newer
 * device-code flow shows a *progress* notification rather than the modal "Proceed To Browser"
 * button, so we eagerly stub `openExternal` for the whole hook lifetime (and still click the
 * modal if it appears), so any auth browser-open runs the local driver regardless of variant.
 */
export function registerAuthHook(secret: string, lambdaId = process.env['AUTH_UTIL_LAMBDA_ARN']) {
    if (process.env['AUTH_UTIL_LOCAL_BROWSER']) {
        const openStub = patchObject(vscode.env, 'openExternal', async (target) => {
            await runLocalBrowserLogin(target.toString(true))
            return true
        })
        const sub = getTestWindow().onDidShowMessage((message) => {
            if (message.items.length > 0 && message.items[0].title.match(new RegExp(proceedToBrowser))) {
                message.items[0].select()
            }
        })
        return {
            dispose: () => {
                sub.dispose()
                openStub.dispose()
            },
        }
    }

    return getTestWindow().onDidShowMessage((message) => {
        if (message.items.length > 0 && message.items[0].title.match(new RegExp(proceedToBrowser))) {
            if (!lambdaId) {
                const baseMessage = 'Browser login flow was shown during testing without an authorizer function'
                if (process.env['AWS_TOOLKIT_AUTOMATION'] === 'local') {
                    throw new Error(`${baseMessage}. You may need to login manually before running tests.`)
                } else {
                    throw new Error(`${baseMessage}. Check that environment variables are set correctly.`)
                }
            }

            const openStub = patchObject(vscode.env, 'openExternal', async (target) => {
                try {
                    // Latest eg: 'https://nkomonen.awsapps.com/start/#/device?user_code=JXZC-NVRK'
                    const urlString = target.toString(true)

                    // Drop the user_code parameter since the auth lambda does not support it yet, and keeping it
                    // would trigger a slightly different UI flow which breaks the automation.
                    // TODO: If the auth lambda supports user_code in the parameters then we can skip this step
                    const verificationUri = urlString.split('?')[0]

                    const params = urlString.split('?')[1]
                    const userCode = new URLSearchParams(params).get('user_code')

                    await invokeLambda(lambdaId, {
                        secret,
                        userCode,
                        verificationUri,
                    })
                } finally {
                    openStub.dispose()
                }

                return true
            })

            message.items[0].select()
        }
    })
}

/**
 * Calls {@link fn} and disposes {@link disposable} after the function finishes
 */
export function using<T extends (...args: any[]) => any>(
    disposable: vscode.Disposable,
    fn: T,
    ...args: Parameters<T>
): ReturnType<T> {
    let isPromise = false

    try {
        const val = fn(...args)
        if (val instanceof Promise) {
            isPromise = true
            return val.finally(() => disposable.dispose()) as any
        }

        return val
    } finally {
        if (!isPromise) {
            disposable.dispose()
        }
    }
}
