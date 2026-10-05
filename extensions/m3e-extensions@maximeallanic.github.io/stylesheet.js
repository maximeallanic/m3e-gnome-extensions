// M3E stylesheet of the extensions, rendered by matugen from the m3e-gnome theme template
// (theme/shell/m3e-extensions-template.css, matugen entry [templates.m3e-extensions]) into
// $XDG_CONFIG_HOME/m3e-gnome/m3e-extensions.css.
// Loaded as an EXTENSION stylesheet (St.Theme.load_stylesheet), so it ranks with the stylesheets of third-party
// extensions; its !important declarations beat them whatever the load order.
// Reloading: when matugen rewrites the file (monitor, 200 ms delay to group the writes), the stylesheet is
// unloaded and loaded again (unload also empties St's per-file cache: the content is re-read). When the Shell theme
// is reloaded (user-theme, material-sync), Main.loadTheme() copies the extension stylesheets into the new theme.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

export const NAME = 'stylesheet';
const DELAY_MS = 200;
// Location written by the m3e-gnome theme (relative to the user config directory).
const STYLESHEET_PATH = ['m3e-gnome', 'm3e-extensions.css'];

let file = null;
let monitor = null;
let monitorId = 0;
let delayId = 0;
let missingReported = false;

export function path() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), ...STYLESHEET_PATH]);
}

const currentTheme = () => St.ThemeContext.get_for_stage(global.stage).get_theme();

function load() {
    if (!file.query_exists(null)) {
        if (!missingReported)
            console.warn(`m3e-extensions: stylesheet missing (${file.get_path()}); run the m3e-gnome theme sync`);
        missingReported = true;
        return;
    }
    missingReported = false;
    try {
        currentTheme().load_stylesheet(file);
    } catch (e) {
        console.error(`m3e-extensions: unreadable stylesheet (${e.message})`);
    }
}

function unload() {
    // No effect if the file is not loaded in this theme.
    currentTheme()?.unload_stylesheet(file);
}

export function reload() {
    unload();
    load();
}

// For the bench: is the stylesheet loaded in the current theme?
export function isLoaded() {
    return (currentTheme()?.get_custom_stylesheets() ?? []).some(f => f.equal(file));
}

export function enable(stylesheetPath = path()) {
    file = Gio.File.new_for_path(stylesheetPath);
    load();
    monitor = file.monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
    monitorId = monitor.connect('changed', () => {
        if (delayId)
            GLib.source_remove(delayId);
        delayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DELAY_MS, () => {
            delayId = 0;
            reload();
            return GLib.SOURCE_REMOVE;
        });
    });
}

export function disable() {
    if (delayId)
        GLib.source_remove(delayId);
    delayId = 0;
    if (monitor) {
        monitor.disconnect(monitorId);
        monitor.cancel();
    }
    monitor = null;
    monitorId = 0;
    if (file)
        unload();
    file = null;
    missingReported = false;
}
