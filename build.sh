#!/bin/sh
# Збирає «SSH Key Maker.app» поруч зі скриптом.
#   ./build.sh            — лише зібрати
#   ./build.sh --install  — зібрати й встановити в /Applications (або ~/Applications)
set -e
cd "$(dirname "$0")"
APP="SSH Key Maker.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -parse-as-library -O SSHKeyMaker.swift -o "$APP/Contents/MacOS/SSHKeyMaker"

# Іконки для всіх платформ (icons/) з icon.png; у .app іде AppIcon.icns
./make-icons.sh
cp icons/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
# SSHKMProjectDir — куди класти теку keys, навіть якщо .app перенесуть у «Програми»
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>SSH Key Maker</string>
  <key>CFBundleDisplayName</key><string>SSH Key Maker</string>
  <key>CFBundleIdentifier</key><string>local.sshkeymaker</string>
  <key>CFBundleExecutable</key><string>SSHKeyMaker</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>SSHKMProjectDir</key><string>$(pwd)</string>
</dict>
</plist>
EOF
codesign --force --sign - "$APP"
echo "Готово: $(pwd)/$APP"

if [ "$1" = "--install" ]; then
  DEST=/Applications
  [ -w "$DEST" ] || DEST="$HOME/Applications"
  mkdir -p "$DEST"
  rm -rf "$DEST/$APP"
  ditto "$APP" "$DEST/$APP"
  # Finder і Dock кешують іконки — оновлюємо запис у Launch Services
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST/$APP"
  touch "$DEST/$APP"
  echo "Встановлено: $DEST/$APP"
fi
