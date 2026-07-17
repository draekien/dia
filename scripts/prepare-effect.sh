#!/usr/bin/env sh

set -eu

repo_dir=".repos/effect"
repo_url="https://github.com/Effect-TS/effect"
repo_tag="effect@3.21.4"

if [ -d "$repo_dir/.git" ]; then
  exit 0
fi

mkdir -p ".repos"
git clone --depth 1 --branch "$repo_tag" "$repo_url" "$repo_dir"
