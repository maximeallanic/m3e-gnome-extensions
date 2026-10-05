// M3E Motion: Material 3 Expressive motion for the native GNOME Shell. One extension for the whole Shell:
// choreographies (container transform, shared axis, fade) and M3E components, all led by the springs of the
// embedded toolkit (m3e/, a single copy for the whole extension: one property registry, one stopAll()).
//
//   motion/gestures.js       : finger velocity at the end of a gesture (SwipeTracker), read by the other modules;
//   motion/windows.js        : opening, closing, minimizing, restoring, resizing of windows;
//   motion/workspaces.js     : workspace switch (shared axis; spring at the end of a gesture);
//   motion/overview.js       : overview and app grid (spring with velocity, shared axis Y, pages);
//   motion/surfaces.js       : switchers, tiling preview, folders, previews, dash labels;
//   motion/system.js         : OSD, modal dialogs, banners;
//   motion/notifications.js  : notification list (position pseudo-classes, list spring);
//   components/*.js          : switch, slider, menus (quick settings and calendar shade), quick settings tiles,
//                              top bar background while the overview is shown.
//
// Every module exports NAME, enable() and disable(). A module that fails to enable is logged, undone with its own
// disable() (so nothing stays half patched) and left out; the others keep going. disable(): stopAll() first
// (motions stopped in place, without onDone), then every module gives back what it took, in reverse order.
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {stopAll} from './m3e/animate.js';
import * as Gestures from './motion/gestures.js';
import * as Windows from './motion/windows.js';
import * as Workspaces from './motion/workspaces.js';
import * as Overview from './motion/overview.js';
import * as Surfaces from './motion/surfaces.js';
import * as System from './motion/system.js';
import * as Notifications from './motion/notifications.js';
import * as Switch from './components/switch.js';
import * as Slider from './components/slider.js';
import * as Menus from './components/menus.js';
import * as Tiles from './components/tiles.js';
import * as View from './components/view.js';

const MODULES = [
    Gestures, Windows, Workspaces, Overview, Surfaces, System, Notifications,
    Switch, Slider, Menus, Tiles, View,
];

function logModuleError(action, module, error) {
    console.error(`m3e-motion: ${action} of ${module.NAME} failed: ${error?.message ?? error}\n${error?.stack ?? ''}`);
}

export default class M3eMotion extends Extension {
    enable() {
        this._active = [];
        for (const module of MODULES) {
            try {
                module.enable();
                this._active.push(module);
            } catch (e) {
                logModuleError('enable', module, e);
                try {
                    module.disable();
                } catch (undoError) {
                    logModuleError('cleanup', module, undoError);
                }
            }
        }
    }

    disable() {
        stopAll();
        for (const module of (this._active ?? []).reverse()) {
            try {
                module.disable();
            } catch (e) {
                logModuleError('disable', module, e);
            }
        }
        this._active = null;
    }
}
