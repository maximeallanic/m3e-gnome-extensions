// Workspace switching in M3E.
//   - Discrete switch (keyboard, click on a thumbnail, action): shared axis X (Y with a vertical layout). The Shell's
//     groups (clones of each workspace's windows, per monitor) are stacked; the outgoing one slides 30 px and fades
//     over [0; 0.35], the incoming one arrives from 30 px and appears over [0.35; 1]. The wallpaper stays fixed: the
//     backgrounds of both groups are hidden and a background of the destination workspace is put underneath.
//   - Gesture (3 fingers, Ctrl+Alt+wheel): the Shell's 1:1 tracking is kept; only the end of the gesture
//     (MonitorGroup.ease_property('progress')) goes on a DefaultSpatial spring with the finger velocity.
// Take-over: a switch during ours starts from the displayed translation and opacity of the arriving workspace
// (geometry velocity reset to 0, rule 5 of pattern.js). If mutter killed the effect (kill-switch-workspace), the
// Shell already declared the switch finished; otherwise we declare it ourselves.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

import {sharedAxis} from '../m3e/patterns.js';
import {Driver, Replacements, animationsAllowed, logFailure} from './utils.js';
import {gestureVelocity} from './gestures.js';

export const NAME = 'workspaces';

const replacements = new Replacements();
let controller = null;
// {switchData, patterns: Map<monitor index, Pattern>, incoming: Map<index, group>, outgoing, to, callback, remaining}
let running = null;
let takeover = null; // {to, t, states: Map<monitor index, {translation_x, translation_y, opacity}>}

const TAKEOVER_PROPS = ['translation_x', 'translation_y', 'opacity'];

// Displayed state of the arriving groups, for the next switch.
function noteTakeover(b) {
    const states = new Map();
    for (const [index, g] of b.incoming) {
        try {
            states.set(index, Object.fromEntries(TAKEOVER_PROPS.map(p => [p, g[p]])));
        } catch {
            // group destroyed: nothing to take over on this monitor
        }
    }
    takeover = {to: b.to, t: GLib.get_monotonic_time(), states};
}

// Ends our running switch without callback (already declared finished to mutter, or to be declared by the caller).
function abandon(c) {
    const b = running;
    if (!b)
        return;
    running = null;
    for (const p of b.patterns.values())
        p.stop();
    if (c._switchData === b.switchData)
        c._finishWorkspaceSwitch(b.switchData);
    c._swipeTracker.enabled = true;
}

function groupOf(mg, index) {
    return mg._workspaceGroups.find(g => g.workspace?.index() === index) ?? null;
}

function animateSwitch(c, from, to, direction, onComplete) {
    // Same order as the Shell's WorkspaceAnimationController.animateSwitch.
    const D = Meta.MotionDirection;
    const backwards = [D.UP, D.LEFT, D.UP_LEFT, D.UP_RIGHT].includes(direction);
    const indices = backwards ? [to, from] : [from, to];
    if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL &&
        direction !== D.UP && direction !== D.DOWN)
        indices.reverse();

    c._swipeTracker.enabled = false;
    c._prepareWorkspaceSwitch(indices);
    const sd = c._switchData;
    sd.inProgress = true;
    const vertical = global.workspace_manager.layout_rows === -1;
    const toWs = global.workspace_manager.get_workspace_by_index(to);
    const b = {switchData: sd, patterns: new Map(), incoming: new Map(), outgoing: new Map(), to,
        callback: onComplete, remaining: 0};
    sd.m3e = b;
    running = b;
    const r = takeover && takeover.to === from && GLib.get_monotonic_time() - takeover.t < 500 * 1000 ? takeover : null;
    takeover = null;

    for (const mg of sd.monitors) {
        const gFrom = groupOf(mg, from), gTo = groupOf(mg, to);
        if (!gFrom || !gTo)
            continue;
        const direction_ = (vertical ? gTo.y > gFrom.y : gTo.x > gFrom.x) ? 1 : -1;
        mg.progress = mg.getWorkspaceProgress(toWs);
        // Both workspaces at the same place; the background stays fixed under them.
        gFrom.set_position(gTo.x, gTo.y);
        gFrom._background?.hide();
        gTo._background?.hide();
        const background = new WorkspaceAnimation.WorkspaceBackground(toWs, mg._monitor);
        mg.insert_child_below(background, mg._container);
        mg._container.set_child_above_sibling(gFrom, gTo);
        const state = r?.states.get(mg.index);
        if (state)
            gFrom.set(state);
        b.remaining++;
        b.incoming.set(mg.index, gTo);
        b.outgoing.set(mg.index, gFrom);
        b.patterns.set(mg.index, sharedAxis(gFrom, gTo, vertical ? 'y' : 'x', direction_, {
            onDone: () => {
                if (running !== b || --b.remaining > 0)
                    return;
                running = null;
                c._finishWorkspaceSwitch(sd);
                c._swipeTracker.enabled = true;
                b.callback?.();
            },
        }));
    }
    if (b.remaining === 0) {
        // No group to animate (workspace absent from a monitor): finished at once.
        running = null;
        c._finishWorkspaceSwitch(sd);
        c._swipeTracker.enabled = true;
        onComplete?.();
    }
}

// --- end of gesture ----------------------------------------------------------------------------------------------

// MonitorGroup -> {driver, dead, restore}: restore puts back the instance method shadowed on the group.
const drivers = new Map();

function driveProgress(mg, target, params) {
    let entry = drivers.get(mg);
    if (!entry) {
        const driver = new Driver(mg, {
            read: () => mg.progress,
            write: v => {
                mg.progress = v;
            },
            spring: 'DefaultSpatial',
            threshold: 0.5 / Math.max(1, mg.baseDistance),
        });
        // Gesture resumed (_switchWorkspaceBegin): remove_all_transitions also stops the spring, in place.
        const own = Object.prototype.hasOwnProperty.call(mg, 'remove_all_transitions');
        const original = mg.remove_all_transitions;
        mg.remove_all_transitions = function () {
            drivers.get(this)?.driver.stop();
            return original.call(this);
        };
        const destroyId = mg.connect('destroy', () => {
            drivers.get(mg)?.driver.destroy();
            drivers.delete(mg);
            entry.dead = true;
        });
        entry = {
            driver,
            dead: false,
            restore: () => {
                if (entry.dead)
                    return; // group destroyed: its instance method went with it
                mg.disconnect(destroyId);
                if (own)
                    mg.remove_all_transitions = original;
                else
                    delete mg.remove_all_transitions;
            },
        };
        drivers.set(mg, entry);
    }
    const points = mg.getSnapPoints();
    const v = gestureVelocity();
    entry.driver.goTo(target, {
        velocity: v === null ? null : v * 1000,
        bounds: [Math.min(...points), Math.max(...points)],
        onComplete: params.onComplete ?? null,
        onStopped: params.onStopped ?? null,
    });
}

// --- wiring ------------------------------------------------------------------------------------------------------

export function enable() {
    controller = Main.wm._workspaceAnimation;
    replacements.replace(controller, 'animateSwitch', original => function (from, to, direction, onComplete) {
        if (!animationsAllowed() || this._switchData?.gestureActivated)
            return original.call(this, from, to, direction, onComplete);
        if (running) {
            // New switch without kill-switch-workspace: the previous one is declared finished here.
            noteTakeover(running);
            abandon(this);
            global.window_manager.completed_switch_workspace();
        }
        try {
            animateSwitch(this, from, to, direction, onComplete);
        } catch (e) {
            logFailure('workspace switch', e);
            abandon(this);
            if (this._switchData)
                this._finishWorkspaceSwitch(this._switchData);
            onComplete?.();
        }
        return undefined;
    });
    replacements.replace(controller, 'cancelSwitchAnimation', original => function () {
        if (running) {
            // kill-switch-workspace: the Shell declares the switch finished right after; the displayed state is kept.
            noteTakeover(running);
            abandon(this);
            return;
        }
        original.call(this);
    });
    // A gesture that starts during our switch finishes it first (otherwise the Shell would reuse our groups).
    replacements.replace(controller, '_prepareWorkspaceSwitch', original => function (indices) {
        if (running && this._switchData === running.switchData && !indices) {
            for (const p of [...running.patterns.values()])
                p.finish();
        }
        return original.call(this, indices);
    });
    replacements.replace(WorkspaceAnimation.MonitorGroup.prototype, 'ease_property', original =>
        function (prop, target, params = {}) {
            if (prop !== 'progress' || !animationsAllowed() || !(params.duration > 0))
                return original.call(this, prop, target, params);
            try {
                driveProgress(this, target, params);
            } catch (e) {
                logFailure('workspace gesture end', e);
                return original.call(this, prop, target, params);
            }
            return undefined;
        });
}

export function disable() {
    if (running && controller) {
        const b = running;
        abandon(controller);
        b.callback?.();
    }
    for (const entry of [...drivers.values()]) {
        entry.driver.finish();
        if (entry.dead)
            continue;
        entry.driver.destroy();
        entry.restore();
    }
    drivers.clear();
    replacements.restore();
    controller = null;
    takeover = null;
}

// For the bench.
export function _diagnostic() {
    let groups = null;
    if (running) {
        const i = Main.layoutManager.primaryIndex;
        const read = g => g ? {tx: Math.round((g.translation_x + g.translation_y) * 1000) / 1000, o: g.opacity}
            : null;
        try {
            groups = {outgoing: read(running.outgoing.get(i)), incoming: read(running.incoming.get(i))};
        } catch {
            groups = null; // groups destroyed while reading: nothing to report
        }
    }
    return {running: running !== null, drivers: drivers.size, groups};
}
