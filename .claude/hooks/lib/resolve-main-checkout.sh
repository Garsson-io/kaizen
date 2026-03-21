#!/bin/bash
# resolve-main-checkout.sh — Resolve the main checkout path dynamically (kaizen #219)
#
# Provides MAIN_CHECKOUT variable pointing to the primary git worktree (main checkout).
# Works from any worktree. Never hardcode paths like /home/aviadr1/projects/nanoclaw.
#
# Usage: source "$(dirname "$0")/lib/resolve-main-checkout.sh"
# Then use $MAIN_CHECKOUT in git -C commands.

MAIN_CHECKOUT="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')"
