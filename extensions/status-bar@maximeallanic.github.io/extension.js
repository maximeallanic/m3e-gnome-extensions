// Android-style status bar:
//   ink-width.js : each status icon takes the width of its ink (St icons are square);
//   volume.js    : the volume indicator only shows when the sound is muted;
//   battery.js   : Android 16 battery, percentage inside the pill, bolt while charging.
// Each module exposes NAME, enable() and disable(). A module that fails to enable is cleaned up, logged and left
// out; the others carry on.
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as InkWidth from './ink-width.js';
import * as Volume from './volume.js';
import * as Battery from './battery.js';

const MODULES = [InkWidth, Volume, Battery];

export default class StatusBar extends Extension {
    enable() {
        this._active = [];
        for (const module of MODULES) {
            try {
                module.enable();
                this._active.push(module);
            } catch (e) {
                console.error(`status-bar: enabling ${module.NAME} failed: ${e.message}\n${e.stack}`);
                this._disableModule(module);
            }
        }
    }

    disable() {
        for (const module of this._active.reverse())
            this._disableModule(module);
        this._active = null;
    }

    _disableModule(module) {
        try {
            module.disable();
        } catch (e) {
            console.error(`status-bar: disabling ${module.NAME} failed: ${e.message}\n${e.stack}`);
        }
    }
}
