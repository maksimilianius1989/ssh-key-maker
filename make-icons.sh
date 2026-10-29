#!/bin/sh
# Робить з icon.png іконки для всіх платформ у теку icons/:
#   icons/icon.ico                                  — Windows (16…256, PNG усередині)
#   icons/hicolor/<N>x<N>/apps/ssh-key-maker.png    — Linux (тема hicolor); 512 — вікно Electron
#   icons/ssh-key-maker.desktop                     — Linux, ярлик меню
#   SSH Key Maker.app/Contents/Resources/AppIcon.icns — macOS
# Потрібні sips та iconutil (є в macOS) і python3.
set -e
cd "$(dirname "$0")"
OUT=icons
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
rm -rf "$OUT"
mkdir -p "$OUT"

png() { sips -z "$1" "$1" icon.png --out "$2" >/dev/null; }

# Linux і вікно Electron
for s in 16 24 32 48 64 128 256 512; do
  mkdir -p "$OUT/hicolor/${s}x${s}/apps"
  png $s "$OUT/hicolor/${s}x${s}/apps/ssh-key-maker.png"
done

# Windows: ICO, що містить PNG-кадри (підтримується з Windows Vista)
ICO_SIZES="16 24 32 48 64 128 256"
for s in $ICO_SIZES; do png $s "$TMP/ico_$s.png"; done
python3 -I - "$OUT/icon.ico" "$TMP" $ICO_SIZES <<'PY'
import struct, sys
out, tmp, sizes = sys.argv[1], sys.argv[2], [int(s) for s in sys.argv[3:]]
frames = [open(f"{tmp}/ico_{s}.png", "rb").read() for s in sizes]
offset = 6 + 16 * len(frames)
head = struct.pack("<HHH", 0, 1, len(frames))
for s, data in zip(sizes, frames):
    side = 0 if s >= 256 else s  # 0 у полі розміру означає 256
    head += struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
with open(out, "wb") as f:
    f.write(head + b"".join(frames))
PY

# Linux: ярлик меню (Exec підставити під свою збірку)
cat > "$OUT/ssh-key-maker.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=SSH Key Maker
Comment=Створення SSH-ключів і налаштування входу на сервер
Exec=ssh-key-maker
Icon=ssh-key-maker
Terminal=false
Categories=Utility;Network;
EOF

# macOS: ICNS для «SSH Key Maker.app»
SET="$TMP/AppIcon.iconset"
mkdir -p "$SET"
for s in 16 32 128 256 512; do
  png $s "$SET/icon_${s}x${s}.png"
  png $((s * 2)) "$SET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$SET" -o "SSH Key Maker.app/Contents/Resources/AppIcon.icns"
touch "SSH Key Maker.app"  # щоб Finder перечитав іконку

echo "Іконки: $(pwd)/$OUT"
