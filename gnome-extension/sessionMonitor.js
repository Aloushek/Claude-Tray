/**
 * sessionMonitor.js — monitors ~/.claude/sessions/ and ~/.claude/notifications/
 *
 * Reads session JSON files written by Claude Code, validates PIDs via /proc,
 * and merges notification status from hook-written notification files.
 *
 * Session file schema (written by Claude Code):
 *   { pid, sessionId, cwd, startedAt, kind, entrypoint }
 *
 * Notification file schema (written by claude-tray-notify.sh):
 *   { sessionId, status, timestamp }
 *   status: "waiting" | "clear"
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Session status values
export const SessionStatus = {
    WORKING: 'working',  // alive, no notification
    WAITING: 'waiting',  // idle_prompt or permission_prompt hook fired
    IDLE: 'idle',        // alive but we have no recent activity signal (e.g. just started)
    DEAD: 'dead',        // PID gone, stale file
};

export class SessionMonitor {
    constructor() {
        this._sessionsDir = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'sessions']);
        this._notificationsDir = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'notifications']);

        this._sessions = new Map();         // sessionId → session object
        this._rateLimits = null;            // latest rate limits from statusLine hook
        this._sessionFileMonitor = null;
        this._notificationFileMonitor = null;
        this._pollTimeoutId = null;
        this._changeCallbacks = [];
        this._refreshInterval = 5;          // seconds, updated via settings
    }

    // Register a callback to be called whenever sessions change
    connect(callback) {
        this._changeCallbacks.push(callback);
        return this._changeCallbacks.length - 1;
    }

    disconnect(id) {
        this._changeCallbacks[id] = null;
    }

    _emit() {
        for (const cb of this._changeCallbacks) {
            if (cb) cb(this._sessions);
        }
    }

    start(refreshInterval = 5) {
        this._refreshInterval = refreshInterval;

        // Ensure notifications dir exists (hooks write here)
        const notifDir = Gio.File.new_for_path(this._notificationsDir);
        try {
            notifDir.make_directory_with_parents(null);
        } catch (_) {
            // already exists — fine
        }

        this._watchDirectory(this._sessionsDir, () => this._refresh());
        this._watchDirectory(this._notificationsDir, () => this._refresh());
        this._startPolling();
        this._refresh();
    }

    stop() {
        if (this._sessionFileMonitor) {
            this._sessionFileMonitor.cancel();
            this._sessionFileMonitor = null;
        }
        if (this._notificationFileMonitor) {
            this._notificationFileMonitor.cancel();
            this._notificationFileMonitor = null;
        }
        if (this._pollTimeoutId) {
            GLib.Source.remove(this._pollTimeoutId);
            this._pollTimeoutId = null;
        }
        this._sessions.clear();
    }

    getSessions() {
        return Array.from(this._sessions.values()).filter(s => s.alive);
    }

    getWaitingCount() {
        return this.getSessions().filter(s => s.status === SessionStatus.WAITING).length;
    }

    getWorkingCount() {
        return this.getSessions().filter(s => s.status === SessionStatus.WORKING).length;
    }

    getRateLimits() {
        return this._rateLimits;
    }

    // --- Private ---

    _watchDirectory(dirPath, onChange) {
        const dir = Gio.File.new_for_path(dirPath);

        // Create dir if it doesn't exist so monitor doesn't fail
        try {
            dir.make_directory_with_parents(null);
        } catch (_) {}

        let monitor;
        try {
            monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            monitor.connect('changed', (_mon, _file, _otherFile, eventType) => {
                // Only act on meaningful events
                if (eventType === Gio.FileMonitorEvent.CREATED ||
                    eventType === Gio.FileMonitorEvent.DELETED ||
                    eventType === Gio.FileMonitorEvent.CHANGED ||
                    eventType === Gio.FileMonitorEvent.RENAMED) {
                    onChange();
                }
            });
        } catch (e) {
            console.warn(`[Claude-Tray] Cannot watch ${dirPath}: ${e.message}`);
            return null;
        }

        if (dirPath === this._sessionsDir) {
            this._sessionFileMonitor = monitor;
        } else {
            this._notificationFileMonitor = monitor;
        }
        return monitor;
    }

    _startPolling() {
        this._pollTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._refreshInterval,
            () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _refresh() {
        const newSessions = new Map();

        // Read session files
        const sessionFiles = this._listJsonFiles(this._sessionsDir);
        for (const { path } of sessionFiles) {
            const data = this._readJson(path);
            if (!data || !data.pid || !data.sessionId) continue;

            const alive = this._isPidAlive(data.pid, data.startedAt);
            if (!alive) continue;

            newSessions.set(data.sessionId, {
                pid: data.pid,
                sessionId: data.sessionId,
                cwd: data.cwd || '~',
                startedAt: data.startedAt || 0,
                kind: data.kind || 'interactive',
                alive: true,
                status: SessionStatus.IDLE,  // default; overwritten by notifications below
                statusChangedAt: null,        // filled in below after status is finalized
            });
        }

        // Apply notification states
        const notifFiles = this._listJsonFiles(this._notificationsDir);
        for (const { path } of notifFiles) {
            const data = this._readJson(path);
            if (!data || !data.sessionId) continue;

            const session = newSessions.get(data.sessionId);
            if (!session) continue;

            if (data.status === 'waiting') {
                session.status = SessionStatus.WAITING;
                if (data.timestamp) session._notifTimestamp = data.timestamp;
            } else if (data.status === 'working') {
                session.status = SessionStatus.WORKING;
                if (data.timestamp) session._notifTimestamp = data.timestamp;
            }
        }

        // Clean up orphan notification files (session no longer exists)
        for (const { path, name } of notifFiles) {
            const data = this._readJson(path);
            if (!data || !data.sessionId) continue;
            if (!newSessions.has(data.sessionId)) {
                try {
                    Gio.File.new_for_path(path).delete(null);
                } catch (_) {}
            }
        }

        // Propagate statusChangedAt: preserve from previous session if status unchanged,
        // set to now if status changed, set to startedAt for brand new sessions.
        const prevSessions = this._sessions;
        const now = Date.now();
        for (const [id, session] of newSessions) {
            const prev = prevSessions.get(id);
            if (!prev) {
                // New session — status change time = session start time
                session.statusChangedAt = session.startedAt || now;
            } else if (prev.status !== session.status) {
                // Status just changed
                // For WAITING, prefer the timestamp from the notification file
                session.statusChangedAt = session._notifTimestamp || now;
            } else {
                // Status unchanged — preserve previous statusChangedAt
                session.statusChangedAt = prev.statusChangedAt || session.startedAt || now;
            }
            delete session._notifTimestamp;
        }

        this._sessions = newSessions;

        // Read rate limits written by statusLine hook
        const rlPath = GLib.build_filenamev([this._notificationsDir, '.rate_limits.json']);
        const rl = this._readJson(rlPath);
        if (rl) this._rateLimits = rl;

        const changed = this._didChange(prevSessions, newSessions);
        if (changed) {
            this._emit();
        }
    }

    _isPidAlive(pid, startedAt) {
        const procPath = `/proc/${pid}`;
        const procFile = Gio.File.new_for_path(procPath);
        if (!procFile.query_exists(null)) return false;

        // Check if stdin (fd/0) is still connected — a (deleted) terminal means
        // the window was closed but the process is still running orphaned.
        // e.g. PhpStorm terminal tab closed: stdin=/dev/pts/5 (deleted), tty_nr=0
        try {
            const fdFile = Gio.File.new_for_path(`/proc/${pid}/fd/0`);
            const info = fdFile.query_info(
                'standard::symlink-target',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );
            const target = info.get_symlink_target() || '';
            if (target.includes('(deleted)')) return false;
        } catch (_) {}

        // Check tty_nr from /proc/stat — 0 means no controlling terminal (orphaned)
        try {
            const [statOk, statBytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
            if (statOk) {
                const parts = new TextDecoder().decode(statBytes).split(' ');
                const ttyNr = parseInt(parts[6] ?? '0', 10);
                if (ttyNr === 0) return false;
            }
        } catch (_) {}

        // Verify the process is actually Claude Code using cmdline (more reliable
        // than comm which is truncated and matches any 'node' process).
        try {
            const [cmdOk, cmdBytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
            if (cmdOk) {
                const cmdline = new TextDecoder().decode(cmdBytes).replace(/\0/g, ' ').trim();
                // Accept if cmdline is "claude ..." or contains "/claude" (full path installs)
                if (!cmdline.startsWith('claude') && !cmdline.includes('/claude')) {
                    return false;
                }
            }
        } catch (_) {}

        // Check for zombie/defunct state — stat field 3 is state char
        try {
            const [ok, contents] = GLib.file_get_contents(`/proc/${pid}/stat`);
            if (ok) {
                const statStr = new TextDecoder().decode(contents);
                // Format: pid (comm) state ppid ...
                // State 'Z' = zombie, 'X' = dead — treat as not alive
                const match = statStr.match(/\)\s+([A-Z])\s/);
                if (match && (match[1] === 'Z' || match[1] === 'X')) {
                    return false;
                }
            }
        } catch (_) {}

        // Guard against PID reuse: compare process start time with session startedAt.
        // /proc/<pid>/stat field 22 is starttime in clock ticks since boot.
        // This is best-effort — if we can't read it, assume alive.
        if (startedAt) {
            try {
                const statPath = `/proc/${pid}/stat`;
                const [ok, contents] = GLib.file_get_contents(statPath);
                if (ok) {
                    const statStr = new TextDecoder().decode(contents);
                    // stat format: pid (comm) state ppid pgroup session tty_nr ...
                    // field 22 (0-indexed field 21) = starttime
                    const parts = statStr.split(' ');
                    if (parts.length > 21) {
                        const startTicks = parseInt(parts[21], 10);
                        const clkTck = 100; // standard HZ on Linux
                        const bootTimeSec = this._getBootTime();
                        if (bootTimeSec > 0) {
                            const procStartMs = (bootTimeSec + startTicks / clkTck) * 1000;
                            // Allow 5s tolerance for timing jitter
                            if (Math.abs(procStartMs - startedAt) > 30000) {
                                return false; // PID reuse detected
                            }
                        }
                    }
                }
            } catch (_) {
                // Can't verify — assume alive
            }
        }
        return true;
    }

    _getBootTime() {
        if (this._bootTimeCached) return this._bootTimeCached;
        try {
            const [ok, contents] = GLib.file_get_contents('/proc/stat');
            if (ok) {
                const text = new TextDecoder().decode(contents);
                const match = text.match(/\nbtime (\d+)/);
                if (match) {
                    this._bootTimeCached = parseInt(match[1], 10);
                    return this._bootTimeCached;
                }
            }
        } catch (_) {}
        return 0;
    }

    _listJsonFiles(dirPath) {
        const dir = Gio.File.new_for_path(dirPath);
        const results = [];
        try {
            const enumerator = dir.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.endsWith('.json')) {
                    results.push({ name, path: GLib.build_filenamev([dirPath, name]) });
                }
            }
            enumerator.close(null);
        } catch (_) {}
        return results;
    }

    _readJson(path) {
        try {
            const [ok, contents] = GLib.file_get_contents(path);
            if (!ok) return null;
            return JSON.parse(new TextDecoder().decode(contents));
        } catch (_) {
            return null;
        }
    }

    _didChange(prev, next) {
        if (prev.size !== next.size) return true;
        for (const [id, session] of next) {
            const old = prev.get(id);
            if (!old) return true;
            if (old.status !== session.status) return true;
            if (old.alive !== session.alive) return true;
        }
        return false;
    }
}
