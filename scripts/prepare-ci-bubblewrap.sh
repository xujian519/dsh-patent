#!/usr/bin/env bash
set -euo pipefail

# Ubuntu's package transaction scans the hosted image's full dpkg database and
# runs post-install hooks. CI needs only the signed-archive payload, so pin and
# verify that payload before extracting it into the ephemeral runner directory.
# This amd64 build needs glibc 2.38+ and Linux 5.10+; Ubuntu 24.04 satisfies both.
readonly BUBBLEWRAP_VERSION='0.12.0-1'
readonly BUBBLEWRAP_SHA256='db4d572a7927bfd34cc9b8e24b56983efa8e0483d03da6c810f6caae081dcc36'
# The recorded build remains addressable after Ubuntu prunes its live package pool.
readonly BUBBLEWRAP_URL="https://launchpad.net/ubuntu/+source/bubblewrap/${BUBBLEWRAP_VERSION}/+build/33546835/+files/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"
# launchpad.net answers 503 often enough to fail the job. The pool copies are the
# same amd64 payload; the pinned digest rejects anything else.
readonly -a BUBBLEWRAP_MIRRORS=(
  "https://archive.ubuntu.com/ubuntu/pool/main/b/bubblewrap/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"
  "https://mirrors.ocf.berkeley.edu/ubuntu/pool/main/b/bubblewrap/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"
)
# Workflows that run on ephemeral runners restore and save this directory as
# `~/.cache/dsh-ci/bubblewrap` with actions/cache, so a warm cache needs no
# Launchpad request; the persistent self-hosted pool keeps the directory itself.
readonly BUBBLEWRAP_CACHE_DIR="${HOME}/.cache/dsh-ci/bubblewrap"

# shellcheck source=scripts/ci-verified-download.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/ci-verified-download.sh"

: "${RUNNER_TEMP:?prepare-ci-bubblewrap requires RUNNER_TEMP}"
: "${GITHUB_PATH:?prepare-ci-bubblewrap requires GITHUB_PATH}"

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'prepare-ci-bubblewrap supports only Linux x86_64 hosted runners' >&2
  exit 1
fi

archive="${BUBBLEWRAP_CACHE_DIR}/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"
root="${RUNNER_TEMP}/dsh-bubblewrap"

# One dead mirror must not spend the job's retry budget: each attempt is bounded
# and verified, and the next URL runs only when this one fails.
prepare_archive() {
  local url
  if acquire_verified_archive "$BUBBLEWRAP_URL" "$BUBBLEWRAP_SHA256" "$archive"; then
    return 0
  fi
  for url in "${BUBBLEWRAP_MIRRORS[@]}"; do
    if acquire_verified_archive "$url" "$BUBBLEWRAP_SHA256" "$archive"; then
      return 0
    fi
    echo "prepare-ci-bubblewrap: ${url} failed download or the pinned SHA256" >&2
  done
  echo 'prepare-ci-bubblewrap: every mirror failed the pinned SHA256' >&2
  return 1
}

prepare_archive
mkdir -p "$root"
dpkg-deb --extract "$archive" "$root"
printf '%s\n' "$root/usr/bin" >> "$GITHUB_PATH"

sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 \
  || echo 'apparmor userns knob absent — the functional probe decides'
"$root/usr/bin/bwrap" --version
"$root/usr/bin/bwrap" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true
echo 'bubblewrap functional probe passed'
