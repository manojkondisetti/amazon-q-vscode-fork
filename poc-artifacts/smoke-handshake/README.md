# Credential-free LSP handshake smoke

Fastest possible proof that an extracted RC language server **launches and speaks LSP** on a
given OS. Needs **no AWS creds, no SSO, no internal values** — so it's the ideal first thing
to run on the CodeBuild Windows runner (de-risks the runner + artifact path before you wire
up the full auth-backed E2E), and the documented fallback if the auth Lambda is blocked.

## Run

```bash
# 1. Get the RC server on disk (public assets only):
./scripts/download-verify-rc.sh agentic-rc-1.70.0 linux-x64 /tmp/rc-lsp
#    (on Windows: scripts/download-verify-rc.ps1 -ReleaseTag agentic-rc-1.70.0 -Platform win-x64 -Dest C:\rc-lsp)

# 2. Point it at the extracted entrypoint (the download script prints the exact path):
node smoke-handshake/handshake-smoke.mjs /tmp/rc-lsp/aws-lsp-codewhisperer.js
```

## Expected

- **Success:** `HANDSHAKE OK — server "..." v... responded with capabilities.` and exit 0.
- **Failure:** `HANDSHAKE FAILED: ...` + server stderr tail, exit 1 (timeout / crash /
  missing capabilities). Exit 2 = bad usage / file not found.

## Negative control

Run it against a deliberately corrupted copy (truncate `aws-lsp-codewhisperer.js`) and
confirm it exits **non-zero**. A smoke that only ever passes proves nothing.

## What it does / doesn't cover

- **Covers:** the RC binary runs on this OS, the `--stdio` transport works, and `initialize`
  returns capabilities. This is exactly the cross-platform "does it even start on Windows"
  question that motivates the whole effort.
- **Does NOT cover:** authenticated behavior (chat/inline), the VS Code client, or the
  `__AMAZONQLSP_PATH` override. Those need the full `poc-lsp-rc.yml` E2E with the auth harness.
