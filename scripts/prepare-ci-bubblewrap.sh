#!/usr/bin/env bash
set -euo pipefail

# Ubuntu's package transaction scans the hosted image's full dpkg database and
# runs post-install hooks. CI needs only the signed-archive payload, so pin and
# verify that payload before extracting it into the ephemeral runner directory.
# This amd64 build needs glibc 2.38+ and Linux 5.10+; Ubuntu 24.04 satisfies both.
readonly BUBBLEWRAP_VERSION='0.12.0-1'
readonly BUBBLEWRAP_SHA256='db4d572a7927bfd34cc9b8e24b56983efa8e0483d03da6c810f6caae081dcc36'
# Launchpad keeps the recorded build after Ubuntu drops it from the live pool,
# but launchpad.net answers 503 often enough to fail the job. The pool copies
# are the same amd64 payload; a checksum mismatch discards them.
readonly -a BUBBLEWRAP_URLS=(
  "https://launchpad.net/ubuntu/+source/bubblewrap/${BUBBLEWRAP_VERSION}/+build/33546835/+files/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"
  "https://archive.ubuntu.com/ubuntu/pool/main/b/bubblewrap/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"
  "https://mirrors.ocf.berkeley.edu/ubuntu/pool/main/b/bubblewrap/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"
)

: "${RUNNER_TEMP:?prepare-ci-bubblewrap requires RUNNER_TEMP}"
: "${GITHUB_PATH:?prepare-ci-bubblewrap requires GITHUB_PATH}"

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'prepare-ci-bubblewrap supports only Linux x86_64 hosted runners' >&2
  exit 1
fi

archive="${RUNNER_TEMP}/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"
root="${RUNNER_TEMP}/dsh-bubblewrap"

# One dead mirror must not spend the job's retry budget. Each URL gets a short
# bounded attempt; the next URL runs only when this download or its checksum fails.
fetched=0
for url in "${BUBBLEWRAP_URLS[@]}"; do
  echo "prepare-ci-bubblewrap: fetching ${url}" >&2
  rm -f "$archive"
  if curl --fail --silent --show-error --location \
    --connect-timeout 15 --max-time 45 \
    --speed-limit 1024 --speed-time 20 \
    --retry 2 --retry-delay 2 --retry-max-time 50 \
    --retry-all-errors \
    --output "$archive" "$url" \
    && printf '%s  %s\n' "$BUBBLEWRAP_SHA256" "$archive" | sha256sum --check --status
  then
    fetched=1
    break
  fi
  echo "prepare-ci-bubblewrap: ${url} failed download or the pinned SHA256" >&2
done
if [[ "$fetched" -ne 1 ]]; then
  echo 'prepare-ci-bubblewrap: every mirror failed the pinned SHA256' >&2
  exit 1
fi
mkdir -p "$root"
dpkg-deb --extract "$archive" "$root"
printf '%s\n' "$root/usr/bin" >> "$GITHUB_PATH"

sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 \
  || echo 'apparmor userns knob absent — the functional probe decides'
"$root/usr/bin/bwrap" --version
"$root/usr/bin/bwrap" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true
echo 'bubblewrap functional probe passed'
