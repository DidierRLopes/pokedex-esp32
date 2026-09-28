#!/usr/bin/env bash
# Build (and optionally flash) the Wi-Fi version of the firmware in its own
# build directory, leaving the default USB build and sdkconfig untouched.
#   tools/build_wifi.sh            # build
#   tools/build_wifi.sh flash      # build + flash (board on USB)
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f sdkconfig.defaults.wifi.local ]; then
  echo "Missing sdkconfig.defaults.wifi.local: copy sdkconfig.defaults.wifi.local.example and fill it in." >&2
  exit 1
fi
source tools/idf_env.sh
PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1 || true)
idf.py -B build-wifi -D SDKCONFIG=sdkconfig.wifi \
  -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.wifi;sdkconfig.defaults.wifi.local" \
  ${1:+-p "$PORT"} build ${1:-}
