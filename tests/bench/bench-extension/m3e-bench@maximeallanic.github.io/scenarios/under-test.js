// Access to the extensions under test (enabled by nested.sh from this repository). A module is imported from the
// URL the extension itself was loaded from, so it is the very instance the Shell runs (same module, same state).
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const MOTION = 'm3e-motion@maximeallanic.github.io';
export const EXTENSIONS = 'm3e-extensions@maximeallanic.github.io';
export const STATUS_BAR = 'status-bar@maximeallanic.github.io';

export function extensionOf(uuid) {
    const ext = Main.extensionManager.lookup(uuid);
    if (!ext)
        throw new Error(`extension not found: ${uuid}`);
    return ext;
}

export async function underTest(uuid, path) {
    const ext = extensionOf(uuid);
    return import(ext.dir.get_child(path).get_uri());
}

export const motion = path => underTest(MOTION, path);
