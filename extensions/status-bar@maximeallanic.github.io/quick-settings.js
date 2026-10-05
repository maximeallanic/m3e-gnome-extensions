// Waiting for a quick settings indicator: QuickSettings creates its indicators in an asynchronous method
// (_setupIndicators) that may finish after the extension is enabled.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Calls ready(indicator) as soon as quickSettings[field] exists. Returns a function that cancels the wait.
export function whenIndicator(field, ready) {
    const quickSettings = Main.panel.statusArea.quickSettings;
    if (quickSettings[field]) {
        ready(quickSettings[field]);
        return () => {};
    }
    let id = quickSettings._indicators.connect('child-added', () => {
        if (!quickSettings[field])
            return;
        quickSettings._indicators.disconnect(id);
        id = 0;
        ready(quickSettings[field]);
    });
    return () => {
        // `id` is cleared as soon as the handler fires, so this also covers the case where the field appeared
        // but the handler has not run yet.
        if (id)
            quickSettings._indicators.disconnect(id);
        id = 0;
    };
}
