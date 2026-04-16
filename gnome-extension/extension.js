/**
 * extension.js — Claude Tray GNOME Shell Extension
 *
 * Monitors active Claude Code sessions and displays status in the top panel.
 * Unofficial community project — not affiliated with Anthropic.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SessionMonitor} from './sessionMonitor.js';
import {ClaudeTrayIndicator} from './indicator.js';

export default class ClaudeTrayExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._monitor = new SessionMonitor();
        this._indicator = new ClaudeTrayIndicator(this);

        // Add indicator to top panel (right side, after system indicators)
        Main.panel.addToStatusArea('claude-tray', this._indicator);

        // Start monitoring with current refresh interval
        const interval = this._settings.get_int('refresh-interval-seconds');
        this._monitor.start(interval);
        this._monitor.setMaxHistory(this._settings.get_int('history-count'));

        // Connect session change events to indicator updates
        this._monitorCallbackId = this._monitor.connect(sessions => {
            this._indicator.updateSessions(sessions, this._settings, this._monitor);
        });

        // Re-start monitor if refresh interval changes
        this._settings.connect('changed::refresh-interval-seconds', () => {
            this._monitor.stop();
            this._monitor.start(this._settings.get_int('refresh-interval-seconds'));
        });

        // Update history limit when setting changes
        this._settings.connect('changed::history-count', () => {
            this._monitor.setMaxHistory(this._settings.get_int('history-count'));
        });

        // Register Super+K keybinding for new Claude session
        this._registerShortcut();

        // Watch for shortcut changes
        this._settings.connect('changed::shortcut-new-session', () => {
            this._unregisterShortcut();
            this._registerShortcut();
        });

        console.log('[Claude-Tray] Extension enabled');
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._monitor) {
            if (this._monitorCallbackId !== undefined) {
                this._monitor.disconnect(this._monitorCallbackId);
            }
            this._monitor.stop();
            this._monitor = null;
        }

        this._unregisterShortcut();
        this._settings = null;

        console.log('[Claude-Tray] Extension disabled');
    }

    _registerShortcut() {
        const shortcuts = this._settings.get_strv('shortcut-new-session');
        if (!shortcuts.length || !shortcuts[0]) return;

        Main.wm.addKeybinding(
            'shortcut-new-session',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._launchNewSession()
        );
        this._shortcutRegistered = true;
    }

    _unregisterShortcut() {
        if (this._shortcutRegistered) {
            Main.wm.removeKeybinding('shortcut-new-session');
            this._shortcutRegistered = false;
        }
    }

    _launchNewSession() {
        const terminal = this._settings.get_string('terminal-command') || 'kitty';
        const cwd = this._settings.get_string('new-session-cwd') || GLib.get_home_dir();
        const workDir = cwd || GLib.get_home_dir();

        try {
            GLib.spawn_async(
                workDir,
                [terminal, '-e', 'claude'],
                null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null
            );
        } catch (e) {
            console.error(`[Claude-Tray] Failed to launch new session: ${e.message}`);
        }
    }
}
