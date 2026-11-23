#!/bin/sh
# Builds the tiny native companion app: helper/bin/HachiwarePet.app
#
# Local development compiles for this Mac only. Releases use
# HACHIWARE_PET_UNIVERSAL=1 so the shipped app runs on both Apple silicon and
# Intel Macs without Xcode Command Line Tools on the user's machine.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP="$DIR/bin/HachiwarePet.app"
RESOURCES="$APP/Contents/Resources"
CACHE="${TMPDIR:-/tmp}/hachiware-pet-module-cache"
BINARY="$APP/Contents/MacOS/HachiwarePet"

mkdir -p "$APP/Contents/MacOS" "$RESOURCES/pet" "$CACHE"
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"
rm -rf "$RESOURCES/pet/skins" "$RESOURCES/pet/skin.js"
cp "$DIR/../pet/index.html" "$DIR/../pet/renderer.js" "$RESOURCES/pet/"

if ! command -v swiftc >/dev/null 2>&1; then
	echo "swiftc is missing: install the Xcode Command Line Tools" >&2
	exit 1
fi

# The sandboxed app process cannot write to the default clang module cache.
compile() {
	target=$1
	output=$2
	CLANG_MODULE_CACHE_PATH="$CACHE" swiftc -swift-version 5 -O \
		${target:+-target "$target"} \
		-module-cache-path "$CACHE" \
		-o "$output" \
		"$DIR/main.swift" \
		-framework Cocoa -framework WebKit
}

if [ "${HACHIWARE_PET_UNIVERSAL:-0}" = "1" ]; then
	compile arm64-apple-macos11 "$BINARY.arm64"
	compile x86_64-apple-macos11 "$BINARY.x86_64"
	lipo -create -output "$BINARY" "$BINARY.arm64" "$BINARY.x86_64"
	rm -f "$BINARY.arm64" "$BINARY.x86_64"
else
	compile "" "$BINARY"
fi

# arm64 refuses to run an unsigned image; ad-hoc signing also lets the app run
# without a Developer ID (npm installs carry no quarantine flag).
codesign --force --sign - --timestamp=none "$APP" >/dev/null 2>&1 || true

echo "built $APP"
