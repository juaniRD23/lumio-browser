#!/bin/sh
# Builds the native Mac helper. Target must be explicit: without -target,
# swiftc stamps the current OS as the minimum and LaunchServices can refuse it.
# Don't codesign separately — the linker already ad-hoc signs the binary.
set -e
cd "$(dirname "$0")"
# ARCH=x86_64 or arm64 builds for that chip into bin/<arch>/ (used for releases);
# by default it builds for this Mac into bin/lumio-helper.
if [ -n "$ARCH" ]; then OUT="bin/$ARCH/lumio-helper"; else ARCH=$(uname -m); OUT="bin/lumio-helper"; fi
mkdir -p "$(dirname "$OUT")"
swiftc -O -swift-version 5 -target "$ARCH-apple-macos14.0" LumioHelper/main.swift \
  -framework AppKit -framework ScreenCaptureKit -framework ApplicationServices -framework LocalAuthentication \
  -o "$OUT"
echo "Built native/$OUT ($ARCH)"
