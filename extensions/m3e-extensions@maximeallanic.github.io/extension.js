// M3E for extensions:
//   stylesheet.js : the m3e-gnome stylesheet for extensions (Dash to Dock and other third-party extensions), loaded
//                   as an extension stylesheet and re-loaded whenever the theme regenerates it;
//   dock.js       : Dash to Dock slide and tooltips on the toolkit's springs (prototype patches, restored by
//                   disable()).
// Engine: copy of the shared m3e toolkit in m3e/ (embedded by scripts/build.sh).
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {stopAll} from './m3e/animate.js';
import * as Stylesheet from './stylesheet.js';
import * as Dock from './dock.js';

const MODULES = [Stylesheet, Dock];

export default class M3eExtensions extends Extension {
    enable() {
        this._active = [];
        for (const module of MODULES) {
            try {
                module.enable();
                this._active.push(module);
            } catch (e) {
                console.error(`m3e-extensions: enabling ${module.NAME} failed: ${e.message}\n${e.stack}`);
                this._disableModule(module);
            }
        }
    }

    disable() {
        // Springs stopped in place first; each module then puts its actors back in a stable state.
        stopAll();
        for (const module of this._active.reverse())
            this._disableModule(module);
        this._active = null;
    }

    _disableModule(module) {
        try {
            module.disable();
        } catch (e) {
            console.error(`m3e-extensions: disabling ${module.NAME} failed: ${e.message}\n${e.stack}`);
        }
    }
}
