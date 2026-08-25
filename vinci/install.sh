#!/usr/bin/env sh
# Vinci Code commercial installer. The public entry point should proxy this file from a short,
# branded HTTPS URL. It installs a stable updater plus versioned payloads with atomic activation.
set -eu

VINCI_HOME="${VINCI_HOME:-$HOME/.vinci-code}"
BIN_DIR="${VINCI_BIN_DIR:-$HOME/.local/bin}"
MANIFEST_URL="${VINCI_UPDATE_MANIFEST_URL:-https://vinci-assets.s3.ca-central-1.amazonaws.com/vinci-code/manifest-beta.json}"

say() { printf '  %s\n' "$*"; }

# A bin dir inside VINCI_HOME makes the shim a symlink to itself. The installer writes the launcher
# under $VINCI_HOME and links $BIN_DIR/vinci at it; when $BIN_DIR is inside $VINCI_HOME those resolve
# to the same path, and every later `vinci` call dies with "too many levels of symbolic links".
# The defaults ($HOME/.vinci-code and $HOME/.local/bin) never collide, so only an explicit
# VINCI_BIN_DIR reaches this. Refuse up front rather than leave a broken install behind.
_vinci_abs() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s' "$PWD/$1" ;; esac; }
_VINCI_HOME_ABS="$(_vinci_abs "$VINCI_HOME")"; _VINCI_HOME_ABS="${_VINCI_HOME_ABS%/}"
_VINCI_BIN_ABS="$(_vinci_abs "$BIN_DIR")"; _VINCI_BIN_ABS="${_VINCI_BIN_ABS%/}"
_vinci_bin_inside_home=0
[ "$_VINCI_BIN_ABS" = "$_VINCI_HOME_ABS" ] && _vinci_bin_inside_home=1
case "$_VINCI_BIN_ABS/" in "$_VINCI_HOME_ABS"/*) _vinci_bin_inside_home=1 ;; esac
if [ "$_vinci_bin_inside_home" = "1" ]; then
  echo "VINCI_BIN_DIR must not be inside VINCI_HOME."
  echo "  VINCI_HOME    = $_VINCI_HOME_ABS"
  echo "  VINCI_BIN_DIR = $_VINCI_BIN_ABS"
  echo "The shim would be a symlink to itself, and 'vinci' would fail with"
  echo "'too many levels of symbolic links'. Point VINCI_BIN_DIR somewhere outside VINCI_HOME."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Vinci Code needs Node.js v22.19 or newer."
  echo "Install it from https://nodejs.org (or 'brew install node'), then run this again."
  exit 1
fi
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' 2>/dev/null; then
  echo "Vinci Code needs Node.js v22.19 or newer — you have $(node -v)."
  echo "Update it from https://nodejs.org (or 'brew upgrade node'), then run this again."
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "Vinci Code needs tar to install its verified release archive."
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "Vinci Code needs curl to download its verified release archive."
  exit 1
fi

# Vinci runs every shell command inside an OS sandbox that confines writes to the workspace.
# macOS has one built in (sandbox-exec); on Linux it is bubblewrap, which most distributions do
# not ship by default. A missing bwrap does NOT stop the install — the agent still reads, edits,
# and answers — so tell the user how to fix it rather than refusing to install.
bubblewrap_install_hint() {
  if command -v apt >/dev/null 2>&1; then
    echo "sudo apt install bubblewrap"
  elif command -v dnf >/dev/null 2>&1; then
    echo "sudo dnf install bubblewrap"
  elif command -v pacman >/dev/null 2>&1; then
    echo "sudo pacman -S bubblewrap"
  elif command -v zypper >/dev/null 2>&1; then
    echo "sudo zypper install bubblewrap"
  else
    echo "install your distribution's 'bubblewrap' package"
  fi
}
# Match the RUNTIME's contract exactly. bwrapPath() in packages/coding-agent/src/core/vinci-sandbox.ts
# accepts ONLY these absolute paths, so a bwrap installed anywhere else — snap, nix, linuxbrew,
# ~/.local/bin — is on PATH yet still leaves bash disabled. Checking PATH here would stay silent for
# exactly the users who are about to hit the failure. Keep this list identical to that function;
# vinci/test/update-integration.mjs asserts the two agree, and drives the branches below by
# repointing this one data line in a copy — so nothing here needs a test-only environment switch.
BWRAP_PATHS="/usr/bin/bwrap /bin/bwrap /usr/local/bin/bwrap"
NEEDS_BUBBLEWRAP=0
if [ "$(uname -s)" = "Linux" ]; then
  NEEDS_BUBBLEWRAP=1
  for _bwrap_candidate in $BWRAP_PATHS; do
    if [ -e "$_bwrap_candidate" ]; then
      NEEDS_BUBBLEWRAP=0
      break
    fi
  done
fi

fetch() {
  _source="$1"
  _destination="$2"
  _maximum_size="${3:-}"
  case "$_source" in
    https://*)
      if [ -n "$_maximum_size" ]; then
        curl -fsSL --connect-timeout 10 --max-time 300 --retry 3 --max-filesize "$_maximum_size" "$_source" -o "$_destination"
      else
        curl -fsSL --connect-timeout 10 --max-time 300 --retry 3 "$_source" -o "$_destination"
      fi
      ;;
    file://*)
      [ "${VINCI_UPDATE_ALLOW_FILE_URLS:-0}" = "1" ] || {
        echo "Local update files are disabled. Set VINCI_UPDATE_ALLOW_FILE_URLS=1 only for testing." >&2
        return 1
      }
      cp "${_source#file://}" "$_destination"
      ;;
    *) echo "Vinci release URLs must use HTTPS." >&2; return 1 ;;
  esac
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "No SHA-256 tool is available (need shasum, sha256sum, or openssl)." >&2
    return 1
  fi
}

PARENT_DIR="$(dirname "$VINCI_HOME")"
mkdir -p "$PARENT_DIR"
STAGE="${VINCI_HOME}.install-$$"
rm -rf "$STAGE"
mkdir -p "$STAGE/payload"
trap 'rm -rf "$STAGE"' EXIT

echo "Installing Vinci Code…"
fetch "$MANIFEST_URL" "$STAGE/manifest.json" 65536

MANIFEST_SIZE="$(wc -c < "$STAGE/manifest.json" | tr -d ' ')"
[ "$MANIFEST_SIZE" -le 65536 ] || {
  echo "The Vinci release manifest is unexpectedly large." >&2
  exit 1
}

# Verify with a key carried by this trusted installer before reading the artifact URL or executing
# anything from the release archive. VINCI_UPDATE_PUBLIC_KEY_PATH is only for local release tests.
TRUSTED_PUBLIC_KEY="$STAGE/trusted-public-key.pem"
if [ -n "${VINCI_UPDATE_PUBLIC_KEY_PATH:-}" ]; then
  cp "$VINCI_UPDATE_PUBLIC_KEY_PATH" "$TRUSTED_PUBLIC_KEY"
else
  printf '%s\n' \
    '-----BEGIN PUBLIC KEY-----' \
    'MCowBQYDK2VwAyEANcQl0YfJ0U8JRoicDLsMMrO9GTMthkKM41u+7AVaG2g=' \
    '-----END PUBLIC KEY-----' > "$TRUSTED_PUBLIC_KEY"
fi
node -e '
  const { readFileSync } = require("node:fs");
  const { verify } = require("node:crypto");
  const envelope = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const signature = typeof envelope.signature === "string" ? Buffer.from(envelope.signature, "base64") : Buffer.alloc(0);
  if (!envelope.signed || signature.length !== 64 || !verify(null, Buffer.from(JSON.stringify(envelope.signed)), readFileSync(process.argv[2]), signature)) {
    console.error("The Vinci release manifest signature is invalid.");
    process.exit(1);
  }
' "$STAGE/manifest.json" "$TRUSTED_PUBLIC_KEY"

VERSION="$(node -e 'const m=require(process.argv[1]); const v=m?.signed?.version; if(typeof v!=="string"||!/^\d+\.\d+\.\d+$/.test(v)) process.exit(1); process.stdout.write(v)' "$STAGE/manifest.json")" || {
  echo "The Vinci release manifest has an invalid version." >&2
  exit 1
}
ARTIFACT_URL="$(node -e 'const m=require(process.argv[1]); const v=m?.signed?.artifact?.url; if(typeof v!=="string") process.exit(1); process.stdout.write(v)' "$STAGE/manifest.json")" || {
  echo "The Vinci release manifest has no artifact URL." >&2
  exit 1
}
EXPECTED_SHA="$(node -e 'const m=require(process.argv[1]); const v=m?.signed?.artifact?.sha256; if(typeof v!=="string"||!/^[a-f0-9]{64}$/.test(v)) process.exit(1); process.stdout.write(v)' "$STAGE/manifest.json")" || {
  echo "The Vinci release manifest has an invalid SHA-256." >&2
  exit 1
}
EXPECTED_SIZE="$(node -e 'const m=require(process.argv[1]); const v=m?.signed?.artifact?.size; if(!Number.isSafeInteger(v)||v<1) process.exit(1); process.stdout.write(String(v))' "$STAGE/manifest.json")" || {
  echo "The Vinci release manifest has an invalid artifact size." >&2
  exit 1
}

# VINCI_TARBALL_URL remains a test/mirror override. Integrity still comes from the signed manifest.
DOWNLOAD_URL="${VINCI_TARBALL_URL:-$ARTIFACT_URL}"
fetch "$DOWNLOAD_URL" "$STAGE/vinci-code.tgz" "$EXPECTED_SIZE"
ACTUAL_SIZE="$(wc -c < "$STAGE/vinci-code.tgz" | tr -d ' ')"
[ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ] || {
  echo "Vinci download failed its size check; the existing installation was left untouched." >&2
  exit 1
}
ACTUAL_SHA="$(sha256_file "$STAGE/vinci-code.tgz")"
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || {
  echo "Vinci download failed SHA-256 verification; the existing installation was left untouched." >&2
  exit 1
}
if tar -tzf "$STAGE/vinci-code.tgz" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "Vinci release archive contains an unsafe path; installation stopped." >&2
  exit 1
fi
tar -xzf "$STAGE/vinci-code.tgz" -C "$STAGE/payload"

UPDATER="$STAGE/payload/vinci/updater/update.mjs"
[ -f "$UPDATER" ] || {
  echo "Vinci release is missing its updater; the existing installation was left untouched." >&2
  exit 1
}
[ -f "$STAGE/payload/vinci/updater/public-key.pem" ] && cmp -s "$TRUSTED_PUBLIC_KEY" "$STAGE/payload/vinci/updater/public-key.pem" || {
  echo "Vinci release contains an unexpected update key; the existing installation was left untouched." >&2
  exit 1
}
node "$UPDATER" verify-manifest --manifest "$STAGE/manifest.json"
node "$UPDATER" install-extracted \
  --home "$VINCI_HOME" \
  --bin-dir "$BIN_DIR" \
  --manifest "$STAGE/manifest.json" \
  --source "$STAGE/payload"

trap - EXIT
rm -rf "$STAGE"
echo ""
say "Vinci Code $VERSION installed to $VINCI_HOME/versions/$VERSION"
say "Automatic beta updates are enabled at the next launch"
say "Launcher linked at $BIN_DIR/vinci"
echo ""
if [ "$NEEDS_BUBBLEWRAP" = "1" ]; then
  say "One step left: Vinci needs bubblewrap to run shell commands safely."
  say "  $(bubblewrap_install_hint)"
  echo ""
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) say "Run:  vinci      (first time: type /login to connect)" ;;
  *) say "Add this to your shell profile, then run 'vinci':"
     say "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
say "Vinci is also on the web, your phone, and your Mac: https://vinci.getsimpledirect.com/get?source=code"
