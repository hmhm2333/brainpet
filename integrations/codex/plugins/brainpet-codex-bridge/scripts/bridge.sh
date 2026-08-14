#!/bin/sh

# Public packages carry a native helper for every supported desktop target.
# The Node fallback keeps source checkouts usable while those artifacts are not
# present, but release validation must reject a public package that relies on it.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -s 2>/dev/null)" in
  Darwin) platform="macos" ;;
  Linux) platform="linux" ;;
  *) platform="" ;;
esac
case "$(uname -m 2>/dev/null)" in
  arm64|aarch64) architecture="arm64" ;;
  x86_64|amd64) architecture="x64" ;;
  *) architecture="" ;;
esac

helper=""
if [ -n "$platform" ] && [ -n "$architecture" ]; then
  helper="$script_dir/../bin/$platform-$architecture/brainpet-hook"
fi

if [ -n "$helper" ] && [ -x "$helper" ]; then
  exec "$helper" --agent codex
fi

if command -v node >/dev/null 2>&1; then
  exec node "$script_dir/bridge.mjs"
fi

exit 0
