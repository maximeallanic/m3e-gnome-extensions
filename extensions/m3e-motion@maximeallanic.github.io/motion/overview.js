// Overview and app grid in M3E.
//   - View state (_stateAdjustment: 0 hidden, 1 windows, 2 grid) led by a DefaultSpatial spring with the current
//     velocity (or the finger's at the end of a gesture). The geometry stays the Shell's: the desktop becomes the
//     workspace card, each window its preview (one container transform per structure). Overshoot is clamped to the
//     segment of states [floor, ceiling]: beyond 1 the grid would come in.
//   - Entering and leaving take each other over mid-way (the Shell waited for one to end before starting the other):
//     same spring, value and velocity kept.
//   - Grid: shared axis Y. At states 0 and 1 it sits at its state-2 place shifted 30 px down; its opacity follows the
//     enter window [0.35; 1] (or the exit window [0; 0.35] on the way back) of the 1 -> 2 progress.
//   - Grid pages: DefaultSpatial spring with velocity (Compose's Pager).
// The contract of the Shell's St.Adjustment.ease is kept (onComplete, onStopped, easeAsync, remove_transition,
// get_transition): all the Shell code that reads the transition state works unchanged.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import St from 'gi://St';

import {PATTERNS} from '../m3e/tokens.js';
import {windowProgress} from '../m3e/patterns.js';
import {Driver, Replacements, animationsAllowed} from './utils.js';
import {gestureVelocity} from './gestures.js';

export const NAME = 'overview';

const {ControlsState} = OverviewControls;
const replacements = new Replacements();
let drivers = [];
let stateDriver = null;
let stateHandlerId = 0;
let controls = null;

// --- adjustments on a spring -------------------------------------------------------------------------------------

// Replaces ease/easeAsync/remove_transition/get_transition of `adj` (instance properties) by a Driver on the clock of
// `clock`. scale(): units of the adjustment per unit of gesture progress; bounds(from, to): clamping (or null).
function driveAdjustment(adj, clock, {spring = 'DefaultSpatial', threshold, scale = () => 1, bounds = null}) {
    const driver = new Driver(clock, {
        read: () => adj.value,
        write: v => {
            adj.value = v;
        },
        spring,
        threshold,
    });
    drivers.push(driver);
    replacements.replace(adj, 'ease', original => function (target, params = {}) {
        if (!animationsAllowed())
            return original.call(this, target, params);
        const callbacks = {onComplete: params.onComplete ?? null, onStopped: params.onStopped ?? null};
        if (!(params.duration > 0) || !clock.mapped) {
            driver.setNow(target, callbacks);
            return undefined;
        }
        const v = gestureVelocity();
        driver.goTo(target, {
            ...callbacks,
            velocity: v === null ? null : v * 1000 * scale(),
            bounds: bounds ? bounds(adj.value, target) : null,
        });
        return undefined;
    });
    replacements.replace(adj, 'easeAsync', () => function (target, params = {}) {
        return new Promise(resolve => {
            this.ease(target, {
                ...params,
                onStopped: finished => {
                    params.onStopped?.(finished);
                    resolve();
                },
            });
        });
    });
    replacements.replace(adj, 'remove_transition', original => function (name) {
        if (name === 'value')
            driver.stop();
        return original.call(this, name);
    });
    replacements.replace(adj, 'get_transition', original => function (name) {
        if (name === 'value' && driver.running) {
            const from = driver.from, to = driver.to;
            return {
                get_interval: () => ({peek_initial_value: () => from, peek_final_value: () => to}),
            };
        }
        return original.call(this, name);
    });
    return driver;
}

// --- take-over of enter and exit ---------------------------------------------------------------------------------

function wireTakeover(overview) {
    // Enter requested during an exit: go toward the requested state without waiting for the exit to end.
    replacements.replace(overview, '_animateVisible', original => function (state) {
        if (!(this._animationInProgress && !this._visibleTarget && stateDriver?.running && animationsAllowed()))
            return original.call(this, state);
        this._visible = true;
        this._visibleTarget = true;
        this._overview.prepareToEnterOverview();
        this._changeShownState('SHOWING'); // OverviewShownState (not exported)
        stateDriver.forgetCallbacks();
        controls._ignoreShowAppsButtonToggle = true;
        controls._stateAdjustment.ease(state, {
            duration: 1,
            onStopped: () => this._showDone(),
        });
        controls.dash.showAppsButton.checked = state === ControlsState.APP_GRID;
        controls._ignoreShowAppsButtonToggle = false;
        return undefined;
    });
    // Exit requested during an enter: same the other way round.
    replacements.replace(overview, '_animateNotVisible', original => function () {
        if (!(this._animationInProgress && this._visibleTarget && stateDriver?.running && animationsAllowed()))
            return original.call(this);
        this._visibleTarget = false;
        Main.layoutManager.overviewGroup.set_child_above_sibling(this._coverPane, null);
        this._coverPane.show();
        this._overview.prepareToLeaveOverview();
        this._changeShownState('HIDING');
        stateDriver.forgetCallbacks();
        this._overview.animateFromOverview(() => this._hideDone());
        return undefined;
    });
}

// --- grid: shared axis Y -----------------------------------------------------------------------------------------

function slide() {
    return PATTERNS.sharedAxis.slidePx * St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

function gridOpacity() {
    const appDisplay = controls._appDisplay;
    if (!appDisplay.visible || controls._searchController.searchActive || appDisplay.get_transition('opacity'))
        return;
    const v = controls._stateAdjustment.value;
    const p = Math.min(1, Math.max(0, v - ControlsState.WINDOW_PICKER));
    const A = PATTERNS.sharedAxis;
    // On the way back (toward the windows view), the grid is the outgoing one: it fades at the start of the return.
    const back = stateDriver?.running && stateDriver.to < stateDriver.from;
    const o = back
        ? 1 - windowProgress(1 - p, A.fadeOut, A.springEffects)
        : windowProgress(p, A.fadeIn, A.springEffects);
    appDisplay.opacity = Math.round(255 * o);
}

function wireGrid() {
    const layout = controls.layout_manager;
    replacements.replace(layout, '_getAppDisplayBoxForState', original => function (state, ...params) {
        if (state === ControlsState.APP_GRID || !animationsAllowed())
            return original.call(this, state, ...params);
        const b = original.call(this, ControlsState.APP_GRID, ...params);
        b.set_origin(b.x1, b.y1 + slide());
        return b;
    });
    stateHandlerId = controls._stateAdjustment.connect('notify::value', () => gridOpacity());
}

// --- wiring ------------------------------------------------------------------------------------------------------

export function enable() {
    controls = Main.overview._overview.controls;
    const height = () => Math.max(1, Main.layoutManager.primaryMonitor?.height ?? global.screen_height);
    stateDriver = driveAdjustment(controls._stateAdjustment, Main.layoutManager.overviewGroup, {
        threshold: 0.5 / height(),
        // Gesture: the finger progress is the state itself (the view's SwipeTracker, distance = screen height).
        scale: () => 1,
        bounds: (from, to) => [Math.floor(Math.min(from, to)), Math.ceil(Math.max(from, to))],
    });
    wireTakeover(Main.overview);
    wireGrid();
    const appDisplay = controls._appDisplay;
    const adj = appDisplay._adjustment;
    if (adj) {
        driveAdjustment(adj, appDisplay, {
            scale: () => adj.page_size,
        });
    }
}

export function disable() {
    if (stateHandlerId && controls)
        controls._stateAdjustment.disconnect(stateHandlerId);
    stateHandlerId = 0;
    // Replacements restored first: the callbacks played below (_showDone, _hideDone...) may start an animation,
    // which must go on the Shell's real transitions and not on a destroyed Driver.
    replacements.restore();
    // Motions finished at their target with their callbacks (the Shell waits for _showDone / _hideDone).
    for (const d of [...drivers]) {
        d.finish();
        d.destroy();
    }
    drivers = [];
    stateDriver = null;
    if (controls) {
        const appDisplay = controls._appDisplay;
        if (!appDisplay.get_transition('opacity') && !controls._searchController.searchActive)
            appDisplay.opacity = 255;
        controls.layout_manager.layout_changed();
    }
    controls = null;
}

// For the bench.
export function _diagnostic() {
    return {state: stateDriver ? {running: stateDriver.running, from: stateDriver.from, to: stateDriver.to} : null};
}
