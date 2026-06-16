#!/usr/bin/env bash
# Download an aws/language-servers RC server asset, verify SHA384 against manifest.json,
# and unzip it. Bash/Unix counterpart of download-verify-rc.ps1 (Linux/macOS local use).
#
# Only touches public GitHub release assets — no internal/AWS values needed.
#
# Usage:
#   ./download-verify-rc.sh <release_tag> <platform> <dest_dir>
#   ./download-verify-rc.sh agentic-rc-1.70.0 linux-x64 /tmp/rc-lsp
#
# platform: win-x64 | linux-x64 | linux-arm64 | mac-x64 | mac-arm64
set -euo pipefail

RELEASE_TAG="${1:?release_tag required}"
PLATFORM="${2:?platform required}"
DEST="${3:?dest_dir required}"
REPO="${REPO:-aws/language-servers}"

BASE="https://github.com/${REPO}/releases/download/${RELEASE_TAG}"
ZIP_NAME="${PLATFORM}-servers.zip"
WORK="$(mktemp -d)"
ZIP_PATH="${WORK}/${ZIP_NAME}"
MANIFEST="${WORK}/manifest.json"

# Map platform label -> manifest (platform, arch).
case "$PLATFORM" in
  win-x64)     M_PLATFORM="windows"; M_ARCH="x64" ;;
  linux-x64)   M_PLATFORM="linux";   M_ARCH="x64" ;;
  linux-arm64) M_PLATFORM="linux";   M_ARCH="arm64" ;;
  mac-x64)     M_PLATFORM="darwin";  M_ARCH="x64" ;;
  mac-arm64)   M_PLATFORM="darwin";  M_ARCH="arm64" ;;
  *) echo "Unknown platform '$PLATFORM'" >&2; exit 2 ;;
esac

echo "Downloading ${ZIP_NAME} and manifest.json from ${RELEASE_TAG} ..."
curl -fsSL "${BASE}/${ZIP_NAME}" -o "${ZIP_PATH}"
curl -fsSL "${BASE}/manifest.json" -o "${MANIFEST}"

# Expected SHA384 for the server zip in the matching target.
EXPECTED="$(jq -r --arg f "$ZIP_NAME" --arg p "$M_PLATFORM" --arg a "$M_ARCH" '
  .versions[].targets[]
  | select(.platform == $p and .arch == $a)
  | .contents[]
  | select(.filename == $f)
  | .hashes[]
  | select(startswith("sha384:"))
  | sub("^sha384:"; "")
' "${MANIFEST}" | head -1)"

if [ -z "${EXPECTED}" ] || [ "${EXPECTED}" = "null" ]; then
  echo "No sha384 for ${ZIP_NAME} (${M_PLATFORM}/${M_ARCH}) in manifest.json" >&2
  exit 1
fi

# Compute local SHA384 (sha384sum on Linux, shasum -a 384 on macOS).
if command -v sha384sum >/dev/null 2>&1; then
  ACTUAL="$(sha384sum "${ZIP_PATH}" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 384 "${ZIP_PATH}" | awk '{print $1}')"
fi

if [ "${ACTUAL,,}" != "${EXPECTED,,}" ] 2>/dev/null; then
  # ${var,,} lowercasing is bash 4+; fall back to tr for macOS bash 3.2.
  ACTUAL_LC="$(printf '%s' "$ACTUAL" | tr '[:upper:]' '[:lower:]')"
  EXPECTED_LC="$(printf '%s' "$EXPECTED" | tr '[:upper:]' '[:lower:]')"
  if [ "${ACTUAL_LC}" != "${EXPECTED_LC}" ]; then
    echo "SHA384 MISMATCH for ${ZIP_NAME}" >&2
    echo "  expected: ${EXPECTED}" >&2
    echo "  actual:   ${ACTUAL}" >&2
    exit 1
  fi
fi
echo "SHA384 verified for ${ZIP_NAME}."

rm -rf "${DEST}"
mkdir -p "${DEST}"
unzip -q "${ZIP_PATH}" -d "${DEST}"

ENTRY="$(find "${DEST}" -name 'aws-lsp-codewhisperer.js' 2>/dev/null | head -1)"
if [ -z "${ENTRY}" ]; then
  echo "WARNING: aws-lsp-codewhisperer.js not found under ${DEST} — check zip layout / __AMAZONQLSP_PATH." >&2
else
  echo "RC extracted. Entry: ${ENTRY}"
  echo "Set __AMAZONQLSP_PATH to: $(dirname "${ENTRY}")"
fi
