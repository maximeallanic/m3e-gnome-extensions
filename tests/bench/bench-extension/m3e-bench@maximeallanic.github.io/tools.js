// Small tools shared by the bench scenarios: waiting, checks, frame statistics.
import GLib from 'gi://GLib';
import St from 'gi://St';

export const SLOWDOWN = 4;
export const FRAME_MS = 1000 / 60; // virtual monitor at 60 Hz (nested.sh)

export const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.round(ms)), () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
export const round3 = v => Math.round(v * 1000) / 1000;
export const setSlowdown = factor => {
    St.Settings.get().slow_down_factor = factor;
};

// Polls `predicate` every 20 ms; resolves to its (truthy) value, or null after `timeoutMs`.
export async function waitUntil(predicate, timeoutMs) {
    const t0 = GLib.get_monotonic_time();
    for (;;) {
        let value = null;
        try {
            value = predicate();
        } catch {
            // The predicate may touch objects that do not exist yet: "not true yet".
            value = null;
        }
        if (value)
            return value;
        if ((GLib.get_monotonic_time() - t0) / 1000 > timeoutMs)
            return null;
        await wait(20);
    }
}

// Checks of a scenario: [{name, ok, detail}].
export class Checks {
    constructor() {
        this.list = [];
    }

    ok(name, condition, detail = '') {
        this.list.push({name, ok: !!condition, detail: `${detail}`});
        return !!condition;
    }

    get all() {
        return this.list.every(c => c.ok);
    }
}

// Lost frames of a trace [{t, ...}] (t in ms): interval above 1.5 display periods.
export function lostFrames(trace) {
    let n = 0;
    for (let i = 1; i < trace.length; i++) {
        if (trace[i].t - trace[i - 1].t > 1.5 * FRAME_MS)
            n++;
    }
    return n;
}

// Result of a scenario judged by its checks (type 'checks').
export function checksResult(checks, extra = {}) {
    return {type: 'checks', ok: checks.list.length > 0 && checks.all, checks: checks.list, ...extra};
}
