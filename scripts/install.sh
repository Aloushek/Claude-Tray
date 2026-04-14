#!/usr/bin/env bash
# install.sh — installs Claude Tray GNOME extension
#
# Creates a symlink from the extension source directory to
# ~/.local/share/gnome-shell/extensions/ and compiles GSettings schema.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"
EXTENSION_SRC="${REPO_ROOT}/gnome-extension"
EXTENSION_UUID="claude-tray@aloushek.github.io"
EXTENSION_DEST="${HOME}/.local/share/gnome-shell/extensions/${EXTENSION_UUID}"

echo "=== Claude Tray — GNOME Extension Installer ==="
echo ""

# Check GNOME Shell
if ! command -v gnome-shell &> /dev/null; then
    echo "Error: gnome-shell not found. Is GNOME installed?" >&2
    exit 1
fi

GNOME_VERSION=$(gnome-shell --version | grep -oP '\d+' | head -1)
echo "Detected GNOME Shell ${GNOME_VERSION}"
if [[ "${GNOME_VERSION}" -lt 45 ]]; then
    echo "Warning: Claude Tray requires GNOME Shell 45+. Detected ${GNOME_VERSION}." >&2
fi

# Install icons to icon theme so GNOME Shell can find symbolic icons
ICON_DEST="${HOME}/.local/share/icons/hicolor/scalable/apps"
mkdir -p "${ICON_DEST}"
for icon in "${EXTENSION_SRC}/icons/"*.svg; do
    cp "${icon}" "${ICON_DEST}/"
done
gtk-update-icon-cache -f -t "${HOME}/.local/share/icons/hicolor" 2>/dev/null || true
echo "Icons installed → ${ICON_DEST}"

# Create or update symlink
mkdir -p "$(dirname "${EXTENSION_DEST}")"
if [[ -L "${EXTENSION_DEST}" ]]; then
    echo "Updating existing symlink…"
    rm "${EXTENSION_DEST}"
elif [[ -d "${EXTENSION_DEST}" ]]; then
    echo "Error: ${EXTENSION_DEST} exists as a real directory (not a symlink)."
    echo "Remove it manually and re-run install.sh"
    exit 1
fi

ln -s "${EXTENSION_SRC}" "${EXTENSION_DEST}"
echo "Extension linked: ${EXTENSION_SRC} → ${EXTENSION_DEST}"

# Compile GSettings schema
SCHEMA_DIR="${EXTENSION_SRC}/schemas"
if command -v glib-compile-schemas &> /dev/null; then
    glib-compile-schemas "${SCHEMA_DIR}"
    echo "GSettings schema compiled"
else
    echo "Warning: glib-compile-schemas not found — install glib2-devel or libglib2.0-dev" >&2
fi

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo ""
echo "  1. Restart GNOME Shell:"
echo "       X11:    Alt+F2 → type 'r' → Enter"
echo "       Wayland: log out and log back in"
echo ""
echo "  2. Enable the extension:"
echo "       gnome-extensions enable ${EXTENSION_UUID}"
echo "     or open 'Extensions' app"
echo ""
echo "  3. (Optional) Install notification hooks for ⚠ waiting status:"
echo "       ./hooks/install-hooks.sh"
echo ""
echo "  4. Open a new Claude session:  Super+K"
echo ""
