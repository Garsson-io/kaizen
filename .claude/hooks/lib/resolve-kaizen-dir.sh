#!/bin/bash
# Part of kAIzen Agent Control Flow
# resolve-kaizen-dir.sh - shared root resolver for hook wrappers.

if [ -z "${KAIZEN_DIR:-}" ]; then
  KAIZEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  export KAIZEN_DIR
fi
