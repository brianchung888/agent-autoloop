#!/bin/sh
# Builds the single executable on macOS and Linux: build/agent-autoloop, and a .sha256 beside it.
#
#   sh scripts/build-binary.sh
#   sh scripts/build-binary.sh --commit <sha> --release v1.2.0 --out /somewhere/agent-autoloop
#
# The build itself is scripts/build-binary.ts, said once for all three platforms — the bundler's --define's, the list
# of files the binary carries, the version written into it. This is the way in on these platforms and nothing more: a
# second copy of that contract, in another language, is a second contract.
#
# Nothing is installed: esbuild and postject come in through `npx --yes`, pinned, and package.json is untouched.
# On a Mac the signature is removed before the blob goes in and an ad-hoc one is put back after, which is what makes
# the result start at all there; the build script does both.
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node --disable-warning=ExperimentalWarning "$repo/scripts/build-binary.ts" "$@"
