#!/usr/bin/env bash
# worktree-du.sh — Thin wrapper, delegates to TypeScript implementation.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/tsx-exec.sh"
tsx_exec worktree-du "$@"
