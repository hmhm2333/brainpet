#!/bin/sh

# Published and local Bridge launchers fail open when the native helper is
# unavailable. They never fall back to Node/npm on an end-user machine.
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

exit 0
