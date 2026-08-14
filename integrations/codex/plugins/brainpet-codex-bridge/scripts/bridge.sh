#!/bin/sh

# Public packages carry a native helper for each supported macOS architecture.
# The Node fallback keeps source checkouts usable while those artifacts are not
# present, but release validation must reject a public package that relies on it.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -m 2>/dev/null)" in
  arm64|aarch64) helper="$script_dir/../bin/macos-arm64/brainpet-hook" ;;
  x86_64|amd64) helper="$script_dir/../bin/macos-x64/brainpet-hook" ;;
  *) helper="" ;;
esac

if [ -n "$helper" ] && [ -x "$helper" ]; then
  exec "$helper" --agent codex
fi

if command -v node >/dev/null 2>&1; then
  exec node "$script_dir/bridge.mjs"
fi

exit 0
