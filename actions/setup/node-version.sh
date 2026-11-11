#!/usr/bin/env bash
# Picks the Node version actions/setup-node gets, and writes `version` and
# `file` to $GITHUB_OUTPUT (one of the two is empty). The first match wins:
#
#   1. NODE_VERSION        the node-version input, as given;
#   2. NODE_VERSION_FILE   the node-version-file input, as given;
#   3. .nvmrc, then .node-version, at the root of the checkout
#                          (CHECKOUT_PATH under $GITHUB_WORKSPACE);
#   4. DEFAULT_NODE_VERSION.
#
# Only one of version and file is ever set: setup-node uses node-version over
# node-version-file when it gets both. The file paths are relative to
# $GITHUB_WORKSPACE, which is where setup-node resolves node-version-file.
set -euo pipefail

version=''
file=''
if [[ -n "${NODE_VERSION:-}" ]]; then
  version="$NODE_VERSION"
elif [[ -n "${NODE_VERSION_FILE:-}" ]]; then
  file="$NODE_VERSION_FILE"
else
  prefix="${CHECKOUT_PATH:+${CHECKOUT_PATH%/}/}"
  for candidate in .nvmrc .node-version; do
    if [[ -f "$GITHUB_WORKSPACE/$prefix$candidate" ]]; then
      file="$prefix$candidate"
      break
    fi
  done
  [[ -n "$file" ]] || version="$DEFAULT_NODE_VERSION"
fi

if [[ -n "$file" ]]; then
  echo "Node version from $file"
else
  echo "Node version $version"
fi
{
  echo "version=$version"
  echo "file=$file"
} >> "$GITHUB_OUTPUT"
