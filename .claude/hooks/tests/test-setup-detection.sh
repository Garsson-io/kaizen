#!/bin/bash
# test-setup-detection.sh — Test kaizen-setup install method detection
#
# Validates that the setup skill's detection logic correctly identifies
# plugin vs submodule vs not-installed states.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# ── Test 1: Plugin install detected via CLAUDE_PLUGIN_ROOT ──

echo "Test 1: Detect plugin install via CLAUDE_PLUGIN_ROOT"
(
  cd "$TEMP_DIR"
  mkdir -p fake-plugin/.claude-plugin
  echo '{}' > fake-plugin/.claude-plugin/plugin.json

  CLAUDE_PLUGIN_ROOT="$TEMP_DIR/fake-plugin"
  if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
    INSTALL_METHOD="plugin"
    KAIZEN_ROOT="$CLAUDE_PLUGIN_ROOT"
  fi

  if [ "$INSTALL_METHOD" = "plugin" ] && [ "$KAIZEN_ROOT" = "$TEMP_DIR/fake-plugin" ]; then
    echo "  PASS: Plugin install detected, KAIZEN_ROOT=$KAIZEN_ROOT"
  else
    echo "  FAIL: Expected plugin install, got method=$INSTALL_METHOD root=$KAIZEN_ROOT"
    exit 1
  fi
)

# ── Test 2: Submodule install detected via .kaizen/.claude-plugin ──

echo "Test 2: Detect submodule install via .kaizen/.claude-plugin"
(
  cd "$TEMP_DIR"
  mkdir -p project2/.kaizen/.claude-plugin
  cd project2

  CLAUDE_PLUGIN_ROOT=""
  INSTALL_METHOD=""
  KAIZEN_ROOT=""

  if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
    INSTALL_METHOD="plugin"
    KAIZEN_ROOT="$CLAUDE_PLUGIN_ROOT"
  elif [ -d ".kaizen/.claude-plugin" ]; then
    INSTALL_METHOD="submodule"
    KAIZEN_ROOT=".kaizen"
  elif [ -d ".kaizen/.claude" ]; then
    INSTALL_METHOD="submodule"
    KAIZEN_ROOT=".kaizen"
  fi

  if [ "$INSTALL_METHOD" = "submodule" ] && [ "$KAIZEN_ROOT" = ".kaizen" ]; then
    echo "  PASS: Submodule install detected"
  else
    echo "  FAIL: Expected submodule install, got method=$INSTALL_METHOD"
    exit 1
  fi
)

# ── Test 3: Submodule install detected via .kaizen/.claude ──

echo "Test 3: Detect submodule install via .kaizen/.claude"
(
  cd "$TEMP_DIR"
  mkdir -p project3/.kaizen/.claude/skills
  cd project3

  CLAUDE_PLUGIN_ROOT=""
  INSTALL_METHOD=""
  KAIZEN_ROOT=""

  if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
    INSTALL_METHOD="plugin"
    KAIZEN_ROOT="$CLAUDE_PLUGIN_ROOT"
  elif [ -d ".kaizen/.claude-plugin" ]; then
    INSTALL_METHOD="submodule"
    KAIZEN_ROOT=".kaizen"
  elif [ -d ".kaizen/.claude" ]; then
    INSTALL_METHOD="submodule"
    KAIZEN_ROOT=".kaizen"
  fi

  if [ "$INSTALL_METHOD" = "submodule" ] && [ "$KAIZEN_ROOT" = ".kaizen" ]; then
    echo "  PASS: Submodule install detected via .claude dir"
  else
    echo "  FAIL: Expected submodule install, got method=$INSTALL_METHOD"
    exit 1
  fi
)

# ── Test 4: No install detected ──

echo "Test 4: No kaizen install detected"
(
  cd "$TEMP_DIR"
  mkdir -p project4
  cd project4

  CLAUDE_PLUGIN_ROOT=""
  INSTALL_METHOD=""
  KAIZEN_ROOT=""

  if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
    INSTALL_METHOD="plugin"
    KAIZEN_ROOT="$CLAUDE_PLUGIN_ROOT"
  elif [ -d ".kaizen/.claude-plugin" ]; then
    INSTALL_METHOD="submodule"
    KAIZEN_ROOT=".kaizen"
  elif [ -d ".kaizen/.claude" ]; then
    INSTALL_METHOD="submodule"
    KAIZEN_ROOT=".kaizen"
  fi

  if [ -z "$INSTALL_METHOD" ]; then
    echo "  PASS: No install correctly detected"
  else
    echo "  FAIL: Expected no install, got method=$INSTALL_METHOD"
    exit 1
  fi
)

# ── Test 5: Plugin takes priority over submodule ──

echo "Test 5: Plugin install takes priority when both exist"
(
  cd "$TEMP_DIR"
  mkdir -p project5/.kaizen/.claude-plugin
  cd project5

  CLAUDE_PLUGIN_ROOT="$TEMP_DIR/fake-plugin"
  INSTALL_METHOD=""
  KAIZEN_ROOT=""

  if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
    INSTALL_METHOD="plugin"
    KAIZEN_ROOT="$CLAUDE_PLUGIN_ROOT"
  elif [ -d ".kaizen/.claude-plugin" ]; then
    INSTALL_METHOD="submodule"
    KAIZEN_ROOT=".kaizen"
  fi

  if [ "$INSTALL_METHOD" = "plugin" ]; then
    echo "  PASS: Plugin takes priority"
  else
    echo "  FAIL: Expected plugin priority, got method=$INSTALL_METHOD"
    exit 1
  fi
)

echo ""
echo "All setup detection tests passed."
