#!/bin/sh
# Thin wrapper: all decision logic lives in the sibling .mjs, which reads the
# hook payload from stdin and writes the decision to stdout.
exec node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/block-git-writes.mjs"
