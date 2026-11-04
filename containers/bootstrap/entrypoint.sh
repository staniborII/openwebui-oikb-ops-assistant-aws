#!/bin/sh
# Starts the setup program. The only accepted mode is setup.
set -eu
mode="${1:-setup}"
case "$mode" in
  setup)
    exec python -m bootstrap.run
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 1
    ;;
esac
