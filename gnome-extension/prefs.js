import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeTrayPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // General page
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // Terminal group
        const terminalGroup = new Adw.PreferencesGroup({
            title: _('Terminal'),
        });
        page.add(terminalGroup);

        const terminalRow = new Adw.EntryRow({
            title: _('Terminal command'),
            text: settings.get_string('terminal-command'),
        });
        terminalRow.connect('notify::text', () => {
            settings.set_string('terminal-command', terminalRow.text);
        });
        terminalGroup.add(terminalRow);

        const cwdRow = new Adw.EntryRow({
            title: _('Default working directory'),
            text: settings.get_string('new-session-cwd'),
        });
        cwdRow.connect('notify::text', () => {
            settings.set_string('new-session-cwd', cwdRow.text);
        });
        terminalGroup.add(cwdRow);

        // Shortcut group
        const shortcutGroup = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcut'),
            description: _('Shortcut to open a new Claude Code session'),
        });
        page.add(shortcutGroup);

        const shortcutRow = new Adw.ActionRow({
            title: _('New session shortcut'),
            subtitle: _('Current: ') + (settings.get_strv('shortcut-new-session')[0] || _('None')),
        });
        const shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: _('Not set'),
            accelerator: settings.get_strv('shortcut-new-session')[0] || '',
            valign: Gtk.Align.CENTER,
        });
        shortcutRow.add_suffix(shortcutLabel);
        shortcutGroup.add(shortcutRow);

        // Update shortcut label when settings change
        settings.connect('changed::shortcut-new-session', () => {
            shortcutLabel.accelerator = settings.get_strv('shortcut-new-session')[0] || '';
        });

        // Notifications group
        const notifyGroup = new Adw.PreferencesGroup({
            title: _('Notifications'),
        });
        page.add(notifyGroup);

        const desktopNotifyRow = new Adw.SwitchRow({
            title: _('Notify when waiting for input'),
            subtitle: _('Show a desktop notification when Claude Code needs your attention'),
        });
        settings.bind('show-desktop-notifications', desktopNotifyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        notifyGroup.add(desktopNotifyRow);

        const thinkingDoneRow = new Adw.SwitchRow({
            title: _('Notify when Claude finishes'),
            subtitle: _('Show a notification when a working session becomes idle'),
        });
        settings.bind('notify-on-thinking-done', thinkingDoneRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        notifyGroup.add(thinkingDoneRow);

        // History group
        const historyGroup = new Adw.PreferencesGroup({
            title: _('Session History'),
        });
        page.add(historyGroup);

        const historyCountRow = new Adw.SpinRow({
            title: _('Recent sessions to show'),
            subtitle: _('Number of ended sessions shown in the dropdown. Set to 0 to disable.'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 50,
                step_increment: 1,
            }),
        });
        settings.bind('history-count', historyCountRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(historyCountRow);

        // Polling group
        const pollingGroup = new Adw.PreferencesGroup({
            title: _('Performance'),
        });
        page.add(pollingGroup);

        const intervalRow = new Adw.SpinRow({
            title: _('Refresh interval (seconds)'),
            subtitle: _('How often to check session status'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
            }),
        });
        settings.bind('refresh-interval-seconds', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        pollingGroup.add(intervalRow);
    }
}
