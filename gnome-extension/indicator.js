/**
 * indicator.js — Panel button and dropdown menu for Claude Tray
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {SessionStatus} from './sessionMonitor.js';

const STATUS_ICON = {
    [SessionStatus.WAITING]: '⚠',
    [SessionStatus.WORKING]: '⏳',
    [SessionStatus.IDLE]:    '✓',
    [SessionStatus.DEAD]:    '',
};

const STATUS_LABEL = {
    [SessionStatus.WAITING]: 'waiting for input',
    [SessionStatus.WORKING]: 'working…',
    [SessionStatus.IDLE]:    'idle',
    [SessionStatus.DEAD]:    'dead',
};

// Format ms duration into human-readable string: "5m", "2h 12m", "3d"
function formatAge(startedAt) {
    const ms = Date.now() - startedAt;
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
    const days = Math.floor(hr / 24);
    return `${days}d`;
}

// Shorten a path for display: replace $HOME with ~, shorten long paths
function shortenPath(fullPath) {
    const home = GLib.get_home_dir();
    let p = fullPath || '?';
    if (p.startsWith(home)) p = '~' + p.slice(home.length);
    // If still long, show only last 2 segments
    const parts = p.split('/').filter(Boolean);
    if (parts.length > 3) {
        p = '…/' + parts.slice(-2).join('/');
    }
    return p;
}


export const ClaudeTrayIndicator = GObject.registerClass(
class ClaudeTrayIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Claude Tray');
        this._extension = extension;
        this._sessions = [];
        this._history = [];
        this._notificationSource = null;
        this._notifiedWaiting = new Set();  // sessionIds we already notified about
        this._timeLabelUpdaters = [];        // functions to call each live-timer tick
        this._liveTimerId = null;
        this._tooltipLabel = null;           // shared floating tooltip label

        // Panel box: icon + count label
        const box = new St.BoxLayout({
            style_class: 'claude-tray-panel-box',
            vertical: false,
        });

        // Load icon directly from extension path — no icon theme cache issues
        const iconPath = extension.path + '/icons/claude-symbolic.svg';
        const gicon = Gio.icon_new_for_string(iconPath);
        this._icon = new St.Icon({
            gicon,
            style_class: 'claude-tray-icon system-status-icon',
        });
        box.add_child(this._icon);

        this._countLabel = new St.Label({
            text: '',
            style_class: 'claude-tray-count',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._countLabel);

        this.add_child(box);
        this._buildMenu();

        // Start/stop 1-second live-update timer based on menu visibility.
        // Also force a refresh on open — catches stale state after shell restart.
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._monitor?.refresh();
                this._startLiveTimer();
            } else {
                this._stopLiveTimer();
            }
        });
    }

    _startLiveTimer() {
        this._stopLiveTimer();
        this._liveTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            for (const update of this._timeLabelUpdaters) update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopLiveTimer() {
        if (this._liveTimerId !== null) {
            GLib.Source.remove(this._liveTimerId);
            this._liveTimerId = null;
        }
    }

    _showTooltip(text) {
        if (!text) return;
        if (!this._tooltipLabel) {
            this._tooltipLabel = new St.Label({style_class: 'tooltip-label dash-label'});
            global.stage.add_child(this._tooltipLabel);
        }
        this._tooltipLabel.text = text;
        const [x, y] = global.get_pointer();
        this._tooltipLabel.set_position(x + 14, y - 32);
        this._tooltipLabel.show();
    }

    _hideTooltip() {
        this._tooltipLabel?.hide();
    }

    _buildMenu() {
        this._timeLabelUpdaters = [];
        this.menu.removeAll();

        // Header (non-clickable title)
        const header = new PopupMenu.PopupMenuItem('Claude Code', {reactive: false});
        header.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(header);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const alive = this._sessions.filter(s => s.alive);

        if (alive.length === 0) {
            const emptyItem = new PopupMenu.PopupMenuItem('No active sessions', {reactive: false});
            emptyItem.label.style_class = 'claude-tray-session-meta';
            this.menu.addMenuItem(emptyItem);
        } else {
            // Sort: waiting first, then working, then idle; within group sort by startedAt desc
            const sorted = [...alive].sort((a, b) => {
                const order = {[SessionStatus.WAITING]: 0, [SessionStatus.WORKING]: 1, [SessionStatus.IDLE]: 2};
                const oa = order[a.status] ?? 3;
                const ob = order[b.status] ?? 3;
                if (oa !== ob) return oa - ob;
                return b.startedAt - a.startedAt;
            });

            for (const session of sorted) {
                this._addSessionItem(session);
            }
        }

        // Recent (history) section
        const historyCount = this._settings?.get_int('history-count') ?? 5;
        if (historyCount > 0 && this._history.length > 0) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Recent'));
            for (const entry of this._history) {
                this._addHistoryItem(entry);
            }
        }

        // Usage bars — own row above buttons
        const rateLimitsData = this._monitor?.getRateLimits?.();
        const rl = rateLimitsData?.rate_limits;
        const w5h = rl?.['5h'];
        const w7d = rl?.['7d'];

        if (w5h != null || w7d != null) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const usageItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            usageItem.remove_all_children();

            const usageBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'claude-tray-usage-box',
            });

            if (w5h != null) usageBox.add_child(this._createRateBar('5h', w5h));
            if (w7d != null) usageBox.add_child(this._createRateBar('7d', w7d));

            usageItem.add_child(usageBox);
            this.menu.addMenuItem(usageItem);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Action buttons row
        const actionsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        actionsItem.remove_all_children();

        const actionsBox = new St.BoxLayout({
            style_class: 'claude-tray-actions-box',
            x_expand: true,
        });

        const newSessionBtn = this._createRoundButton(
            'list-add-symbolic',
            'New Claude session in ~/ (Super+K)',
            () => {
                this.menu.close();
                this._launchNewSession();
            }
        );
        actionsBox.add_child(newSessionBtn);

        const prefsBtn = this._createRoundButton(
            'preferences-system-symbolic',
            'Preferences',
            () => {
                this.menu.close();
                this._extension.openPreferences();
            }
        );
        actionsBox.add_child(prefsBtn);

        actionsItem.add_child(actionsBox);
        this.menu.addMenuItem(actionsItem);
    }

    _createRoundButton(iconName, tooltip, onClick) {
        const button = new St.Button({
            style_class: 'message-list-clear-button button claude-tray-action-btn',
            can_focus: true,
            x_expand: false,
        });
        button.child = new St.Icon({
            icon_name: iconName,
            style_class: 'popup-menu-icon',
        });
        if (tooltip) button.accessible_name = tooltip;
        button.connect('clicked', onClick);
        return button;
    }

    _createRateBar(windowLabel, window) {
        const pct = window.percent != null ? Math.round(window.percent) : 0;
        const pctClamped = Math.max(0, Math.min(100, pct));

        // Color: green → orange → red as usage grows
        let fillColor;
        if (pct < 50)       fillColor = 'rgba(74, 222, 128, 0.85)';
        else if (pct < 80)  fillColor = 'rgba(249, 115, 22, 0.85)';
        else                fillColor = 'rgba(239, 68, 68, 0.85)';

        // Compute tooltip text for reset time
        let rstTooltip = '';
        if (window.resets_at) {
            const secLeft = Math.floor(window.resets_at - Date.now() / 1000);
            if (secLeft > 0) {
                const h = Math.floor(secLeft / 3600);
                const m = Math.floor((secLeft % 3600) / 60);
                const timeStr = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
                rstTooltip = `Usage window resets in ${timeStr}`;
            } else {
                rstTooltip = 'Usage window resetting soon';
            }
        }

        // Row: "5h" label | track bar | "26%" label
        const row = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin: 2px 0;',
        });

        row.add_child(new St.Label({
            text: windowLabel,
            style_class: 'claude-tray-usage-line',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 2em;',
        }));

        // Track: dark background strip
        const track = new St.Widget({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: rstTooltip !== '',
            style: `
                height: 8px;
                background-color: rgba(255,255,255,0.12);
                border-radius: 4px;
                margin: 0 6px;
            `,
        });

        // Fill: coloured portion — width updated on track allocation
        const fill = new St.Widget({
            style: `
                height: 8px;
                background-color: ${fillColor};
                border-radius: 4px;
            `,
            x_expand: false,
            y_expand: false,
        });
        fill.set_position(0, 0);
        track.layout_manager = new Clutter.FixedLayout();
        track.add_child(fill);

        track.connect('notify::width', () => {
            const w = Math.round(track.width * pctClamped / 100);
            fill.set_size(Math.max(0, w), 8);
        });

        // Tooltip: show reset time on hover via notify::hover
        if (rstTooltip) {
            track.track_hover = true;
            track.connect('notify::hover', () => {
                if (track.hover) this._showTooltip(rstTooltip);
                else this._hideTooltip();
            });
        }

        row.add_child(track);

        row.add_child(new St.Label({
            text: `${pct}%`,
            style_class: 'claude-tray-usage-line',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 3em; text-align: right;',
        }));

        return row;
    }

    _addSessionItem(session) {
        const item = new PopupMenu.PopupMenuItem('');
        item.remove_all_children();

        // Build a horizontal layout inside the item
        const box = new St.BoxLayout({
            style_class: 'claude-tray-session-item',
            x_expand: true,
        });

        // Status icon
        const statusIcon = new St.Label({
            text: STATUS_ICON[session.status] || '?',
            style_class: `claude-tray-status-${session.status}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(statusIcon);

        // Text block: title (or cwd if no title), then cwd + status meta
        const textBox = new St.BoxLayout({vertical: true, x_expand: true});

        const primaryLabel = new St.Label({
            text: session.title ? session.title : shortenPath(session.cwd),
            style_class: 'claude-tray-session-cwd',
        });
        textBox.add_child(primaryLabel);

        // Secondary line: cwd (if title shown above) + status age
        const metaLabel = new St.Label({
            text: '',
            style_class: 'claude-tray-session-meta',
        });
        const updateMeta = () => {
            const statusAge = session.statusChangedAt ? formatAge(session.statusChangedAt) : '?';
            const sessionAge = formatAge(session.startedAt);
            const cwdPart = session.title ? `${shortenPath(session.cwd)}  ·  ` : '';
            const ctxPart = session.ctxPct != null ? `  ·  ctx:${Math.round(session.ctxPct)}%` : '';
            metaLabel.text = `${cwdPart}${STATUS_LABEL[session.status]} ${statusAge}  ·  started ${sessionAge} ago${ctxPart}`;
        };
        updateMeta();
        this._timeLabelUpdaters.push(updateMeta);
        textBox.add_child(metaLabel);
        box.add_child(textBox);

        item.add_child(box);

        item.connect('activate', () => this._resumeSession(session));
        this.menu.addMenuItem(item);
    }

    _addHistoryItem(entry) {
        const item = new PopupMenu.PopupMenuItem('');
        item.remove_all_children();

        const box = new St.BoxLayout({
            style_class: 'claude-tray-session-item',
            x_expand: true,
        });

        // Status icon (muted — session is over)
        const statusIcon = new St.Label({
            text: '⏸',
            style_class: 'claude-tray-status-idle',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(statusIcon);

        // Line 1: title (if available) or cwd
        const textBox = new St.BoxLayout({vertical: true, x_expand: true});
        textBox.add_child(new St.Label({
            text: entry.title ? entry.title : shortenPath(entry.cwd),
            style_class: 'claude-tray-session-cwd',
        }));

        // Line 2: cwd on its own line (only when title shown above)
        if (entry.title) {
            textBox.add_child(new St.Label({
                text: shortenPath(entry.cwd),
                style_class: 'claude-tray-session-meta',
            }));
        }

        // Line 3 (or 2 when no title): ended-ago, live
        const metaLabel = new St.Label({
            text: '',
            style_class: 'claude-tray-session-meta',
        });
        const updateMeta = () => {
            metaLabel.text = `ended ${formatAge(entry.endedAt)} ago`;
        };

        updateMeta();
        this._timeLabelUpdaters.push(updateMeta);
        textBox.add_child(metaLabel);
        box.add_child(textBox);

        item.add_child(box);

        item.connect('activate', () => this._resumeHistoryEntry(entry));
        this.menu.addMenuItem(item);
    }

    // Update sessions data and re-render
    updateSessions(sessionsMap, settings, monitor) {
        this._settings = settings;
        this._monitor = monitor;
        this._sessions = Array.from(sessionsMap.values());
        this._history = monitor?.getHistory?.() ?? [];
        this._updatePanel();
        this._buildMenu();
        this._handleNotifications();
    }

    _updatePanel() {
        const alive = this._sessions.filter(s => s.alive);
        const count = alive.length;
        const hasWaiting = alive.some(s => s.status === SessionStatus.WAITING);
        const hasWorking = alive.some(s => s.status === SessionStatus.WORKING);

        // Update count label
        if (count === 0) {
            this._countLabel.text = '';
            this._countLabel.style_class = 'claude-tray-count claude-tray-count-zero';
        } else {
            this._countLabel.text = String(count);
            let cls = 'claude-tray-count-active';
            if (hasWaiting) cls = 'claude-tray-count-waiting';
            else if (hasWorking) cls = 'claude-tray-count-working';
            this._countLabel.style_class = `claude-tray-count ${cls}`;
        }

        // Update icon color based on state:
        //   red     — waiting for user input (needs action)
        //   orange  — working (Claude is processing)
        //   white   — idle or no sessions
        if (hasWaiting) {
            this._icon.style = 'color: #ef4444;';  // red
        } else if (hasWorking) {
            this._icon.style = 'color: #f97316;';  // orange
        } else {
            this._icon.style = '';  // inherit panel color (white on dark panel)
        }
    }

    _handleNotifications() {
        if (!this._settings?.get_boolean('show-desktop-notifications')) return;

        for (const session of this._sessions) {
            if (session.status === SessionStatus.WAITING && !this._notifiedWaiting.has(session.sessionId)) {
                this._notifiedWaiting.add(session.sessionId);
                this._sendNotification(
                    'Claude Code needs your input',
                    `${shortenPath(session.cwd)}  ·  ${formatAge(session.startedAt)}`
                );
            } else if (session.status !== SessionStatus.WAITING) {
                this._notifiedWaiting.delete(session.sessionId);
            }
        }
    }

    _sendNotification(title, body) {
        if (!this._notificationSource) {
            const iconName = 'claude-symbolic';
            this._notificationSource = new MessageTray.Source({
                title: 'Claude Tray',
                iconName,
            });
            this._notificationSource.connect('destroy', () => {
                this._notificationSource = null;
            });
            Main.messageTray.add(this._notificationSource);
        }

        const notification = new MessageTray.Notification({
            source: this._notificationSource,
            title,
            body,
            isTransient: false,
        });
        this._notificationSource.addNotification(notification);
    }

    _resumeSession(session) {
        // Try to focus the existing window first
        const windowId = this._findWindowForPid(session.pid);
        if (windowId) {
            try {
                // wmctrl -ia: activate window by hex ID (raises + focuses)
                GLib.spawn_sync(null, ['wmctrl', '-ia', windowId], null,
                    GLib.SpawnFlags.SEARCH_PATH, null);
                return;
            } catch (e) {
                console.warn(`[Claude-Tray] wmctrl focus failed: ${e.message}`);
            }
        }

        // Fallback: open a new terminal and resume by sessionId
        console.log(`[Claude-Tray] No window found for pid ${session.pid}, opening new terminal`);
        const terminal = this._settings?.get_string('terminal-command') || 'kitty';
        const cmd = [terminal, '-e', 'bash', '-c',
            `cd '${session.cwd}' && claude --resume '${session.sessionId}' || claude`];
        try {
            GLib.spawn_async(null, cmd, null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null);
        } catch (e) {
            console.error(`[Claude-Tray] Failed to resume session: ${e.message}`);
        }
    }

    _resumeHistoryEntry(entry) {
        const terminal = this._settings?.get_string('terminal-command') || 'kitty';
        const cmd = [terminal, '-e', 'bash', '-c',
            `cd '${entry.cwd}' && claude --resume '${entry.sessionId}' || claude`];
        try {
            GLib.spawn_async(null, cmd, null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null);
        } catch (e) {
            console.error(`[Claude-Tray] Failed to resume history entry: ${e.message}`);
        }
    }

    /**
     * Walk the process tree from pid upward until we find a PID that owns
     * an X11 window. Returns the window ID as a hex string, or null.
     *
     * Works for: kitty (single window), PhpStorm (main window), any terminal.
     * For multi-window apps (PhpStorm), focuses whichever window xdotool finds first.
     */
    _findWindowForPid(pid) {
        let currentPid = pid;
        for (let depth = 0; depth < 12; depth++) {
            if (!currentPid || currentPid <= 1) break;

            // Ask xdotool for windows belonging to this PID
            try {
                const [, stdout] = GLib.spawn_sync(
                    null,
                    ['xdotool', 'search', '--pid', String(currentPid)],
                    null,
                    GLib.SpawnFlags.SEARCH_PATH,
                    null
                );
                if (stdout) {
                    const wids = new TextDecoder().decode(stdout).trim().split('\n').filter(Boolean);
                    if (wids.length > 0) {
                        // Convert decimal window ID to hex for wmctrl -ia
                        const dec = parseInt(wids[0], 10);
                        return `0x${dec.toString(16)}`;
                    }
                }
            } catch (_) {}

            // Walk up: read PPid from /proc/<pid>/status
            try {
                const [ok, contents] = GLib.file_get_contents(`/proc/${currentPid}/status`);
                if (!ok) break;
                const match = new TextDecoder().decode(contents).match(/PPid:\s*(\d+)/);
                if (!match) break;
                currentPid = parseInt(match[1], 10);
            } catch (_) {
                break;
            }
        }
        return null;
    }

    _launchNewSession() {
        const terminal = this._settings?.get_string('terminal-command') || 'kitty';
        const cwd = this._settings?.get_string('new-session-cwd') || GLib.get_home_dir();
        const workDir = cwd || GLib.get_home_dir();
        const cmd = [terminal, '-e', 'claude'];
        try {
            GLib.spawn_async(workDir, cmd, null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null);
        } catch (e) {
            console.error(`[Claude-Tray] Failed to launch new session: ${e.message}`);
        }
    }

    destroy() {
        this._stopLiveTimer();
        if (this._tooltipLabel) {
            this._tooltipLabel.destroy();
            this._tooltipLabel = null;
        }
        super.destroy();
    }
});
