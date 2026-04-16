# Claude-Tray

> **Disclaimer:** This is an unofficial community project and is not affiliated with, endorsed by, or associated with Anthropic. Claude and Claude Code are trademarks of Anthropic.

A GNOME Shell extension that monitors active [Claude Code](https://claude.ai/code) sessions and shows their status in the top panel.

## Features

- Live count of active Claude Code sessions in the top panel
- Status badges: ⚠ waiting for your input, ⏳ thinking/working
- Dropdown with all sessions showing working directory and elapsed time
- Click any session to resume it in a new Kitty terminal window
- `Super+K` shortcut to open a new Claude Code session in `~/`
- Desktop notifications when Claude is waiting for your input

## Requirements

- GNOME Shell 46+
- `kitty` terminal
- `claude` CLI installed and in PATH
- `jq` (for hook installer)

## Install

```bash
git clone https://github.com/Aloushek/Claude-Tray.git
cd Claude-Tray
./scripts/install.sh
./hooks/install-hooks.shV

# On X11: Alt+F2 → r → Enter to restart GNOME Shell
# On Wayland: log out and back in

gnome-extensions enable claude-tray@aloushek.github.io
```

## How it works

The extension monitors `~/.claude/sessions/` for active Claude Code session files (each contains PID, session ID, and working directory). It verifies each session is still alive via `/proc/<pid>`.

For waiting/thinking status, it installs notification hooks into `~/.claude/settings.json`. When Claude Code enters an `idle_prompt` or `permission_prompt` state, it writes a status file to `~/.claude/notifications/` which the extension picks up via inotify.

## Configuration

Open GNOME Extensions → Claude Tray → Preferences, or run:

```bash
gnome-extensions prefs claude-tray@aloushek.github.io
```

Available settings:
- **Terminal command** (default: `kitty`)
- **Shortcut** for new session (default: `Super+K`)
- **Refresh interval** in seconds (default: `5`)
- **Desktop notifications** on/off

## Phase 2 roadmap

- Standalone daemon for cross-desktop support (KDE, XFCE, Sway/Hyprland via Waybar)
- Token/cost display via statusLine integration
- PhpStorm integration (open Claude Code in current project)

## License

GNU GPL v3 — see [LICENSE](LICENSE).
