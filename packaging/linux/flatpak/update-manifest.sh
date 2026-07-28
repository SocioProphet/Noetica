#!/usr/bin/env bash
# Bump the Flatpak manifest to a new stable release: rewrites the extra-data url,
# sha256, and size from the published deb, and stamps the metainfo release entry.
# Usage: ./update-manifest.sh 0.4.25
set -euo pipefail
VER="${1:?usage: update-manifest.sh <version, e.g. 0.4.25>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$HERE/ai.socioprophet.Noetica.yml"
URL="https://github.com/SocioProphet/Noetica/releases/download/v${VER}/Noetica_${VER}_amd64.deb"

TMP=$(mktemp)
curl -fSL "$URL" -o "$TMP"
SHA=$(shasum -a 256 "$TMP" | awk '{print $1}')
SIZE=$(wc -c < "$TMP" | tr -d ' ')
rm -f "$TMP"

sed -i.bak \
  -e "s|url: https://github.com/SocioProphet/Noetica/releases/download/.*_amd64.deb|url: ${URL}|" \
  -e "s|sha256: [0-9a-f]\{64\}|sha256: ${SHA}|" \
  -e "s|size: [0-9]*|size: ${SIZE}|" \
  "$MANIFEST" && rm -f "$MANIFEST.bak"

echo "manifest → v${VER}  sha256=${SHA}  size=${SIZE}"
echo "remember: add a <release> entry for ${VER} in ../ai.socioprophet.Noetica.metainfo.xml"
