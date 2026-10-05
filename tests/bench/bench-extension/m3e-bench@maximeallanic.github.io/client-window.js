// Wayland test client of the bench: a client-side decorated GTK 4 window (CSD, shadows) titled ARGV[1].
// ARGV[0] = 'window': the window alone; 'dialog': the window, then after one second a transient modal dialog.
// Started by the bench against the nested Shell only (WAYLAND_DISPLAY of the nested Shell, private
// XDG_RUNTIME_DIR) and killed by PID at the end of the scenario. Start nothing else with it.
imports.gi.versions.Gtk = '4.0';
const {GLib, Gtk} = imports.gi;

Gtk.init();
const mode = ARGV[0] || 'window';
const title = ARGV[1] || 'Bench window';
const window = new Gtk.Window({title, default_width: 720, default_height: 480});
window.set_child(new Gtk.Label({label: title}));
const loop = GLib.MainLoop.new(null, false);
window.connect('close-request', () => {
    loop.quit();
    return false;
});
window.present();
if (mode === 'dialog') {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        const dialog = new Gtk.Window({title: `${title} - dialog`, modal: true, transient_for: window,
            default_width: 360, default_height: 200});
        dialog.set_child(new Gtk.Label({label: 'Bench dialog'}));
        dialog.present();
        return GLib.SOURCE_REMOVE;
    });
}
loop.run();
