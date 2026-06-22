#!/usr/bin/env bash
# Build Noetica .deb package
set -euo pipefail

VERSION="${1:-0.4.11}"
ARCH="${2:-amd64}"
PACKAGE="noetica"
STAGE_DIR="$(mktemp -d)"
DEB_ROOT="$STAGE_DIR/DEBIAN"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "Building $PACKAGE ${VERSION} (${ARCH})..."

mkdir -p "$DEB_ROOT"
mkdir -p "$STAGE_DIR/usr/share/noetica"
mkdir -p "$STAGE_DIR/etc/noetica"
mkdir -p "$STAGE_DIR/lib/systemd/system"
mkdir -p "$STAGE_DIR/usr/share/applications"
mkdir -p "$STAGE_DIR/usr/share/metainfo"

# Copy application files (exclude dev deps, tests, .git)
rsync -a --exclude=node_modules --exclude=.git --exclude='*.test.*' \
  --exclude=packaging --exclude=dist \
  "$REPO_ROOT/" "$STAGE_DIR/usr/share/noetica/" 2>/dev/null || \
  cp -r "$REPO_ROOT/." "$STAGE_DIR/usr/share/noetica/"

# Systemd unit
cp "$SCRIPT_DIR/noetica.service" "$STAGE_DIR/lib/systemd/system/"

# Desktop and metainfo (if they exist)
for f in ai.noetica.app.desktop ai.noetica.app.metainfo.xml; do
  src="$REPO_ROOT/packaging/linux/$f"
  if [ -f "$src" ]; then
    if [[ "$f" == *.desktop ]]; then
      cp "$src" "$STAGE_DIR/usr/share/applications/"
    elif [[ "$f" == *.xml ]]; then
      cp "$src" "$STAGE_DIR/usr/share/metainfo/"
    fi
  fi
done

# DEBIAN metadata
sed "s/^Version:.*/Version: $VERSION/; s/^Architecture:.*/Architecture: $ARCH/" \
  "$SCRIPT_DIR/control" > "$DEB_ROOT/control"
for f in postinst prerm postrm; do
  cp "$SCRIPT_DIR/$f" "$DEB_ROOT/$f"
  chmod 755 "$DEB_ROOT/$f"
done

OUTPUT="${PACKAGE}_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$STAGE_DIR" "$OUTPUT"
echo "Built: $OUTPUT"
