// Helpers shared by the Shell surface modules (surfaces.js, system.js): touched actors put back at rest on disable(),
// pending ends replayed on disable(), motions guarded per actor, protected wiring.
import {Replacements, logFailure} from './utils.js';

export const restDisplayed = a => a.set({opacity: 255, scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0});

export class Tracker {
    constructor(name) {
        this.name = name;
        this.replacements = new Replacements();
        // Touched actors: actor -> {restore: function putting it back at rest, id: destroy handler}.
        this._touched = new Map();
        // Pending ends (one per actor: a take-over replaces the previous one, which will never happen). disable()
        // plays them all after stopAll(): a dialog that was closing closes, a banner that was leaving leaves, etc.
        this._ends = new Map();
        // Actors whose destruction is followed for the ends: actor -> handler id.
        this._endWatchers = new Map();
    }

    touch(actor, restore) {
        if (!this._touched.has(actor)) {
            const id = actor.connect('destroy', () => this._touched.delete(actor));
            this._touched.set(actor, {restore, id});
        }
    }

    followEnd(actor, onDone) {
        const f = () => {
            if (this._ends.get(actor) === f)
                this._ends.delete(actor);
            onDone();
        };
        this._ends.set(actor, f);
        // Actor destroyed before the end: animate() and patterns stop without onDone, the entry is forgotten (never
        // replayed on a destroyed object).
        if (!this._endWatchers.has(actor)) {
            const id = actor.connect('destroy', () => {
                this._ends.delete(actor);
                this._endWatchers.delete(actor);
            });
            this._endWatchers.set(actor, id);
        }
        return f;
    }

    forgetEnd(actor) {
        this._ends.delete(actor);
    }

    // Motions guarded per actor (stopped before falling back to the Shell's original method, which does not see them:
    // they are led by Clutter.Timeline, not by transitions).
    stopGuarded(...actors) {
        for (const a of actors) {
            for (const m of a?._m3eGuarded ?? [])
                m.stop();
            if (a) {
                a._m3eGuarded = [];
                this._ends.delete(a);
            }
        }
    }

    guard(actor, ...motions) {
        actor._m3eGuarded = [...actor._m3eGuarded ?? [], ...motions];
    }

    enable(wirings) {
        for (const w of wirings) {
            try {
                w();
            } catch (e) {
                logFailure(`${this.name}, ${w.name}`, e);
            }
        }
    }

    disable() {
        // Pending ends played (stopAll() stopped the motions without onDone).
        for (const f of [...this._ends.values()]) {
            try {
                f();
            } catch (e) {
                logFailure('pending end', e);
            }
        }
        this._ends.clear();
        this.replacements.restore();
        for (const [actor, {restore, id}] of this._touched) {
            try {
                actor.disconnect(id);
                restore(actor);
            } catch (e) {
                logFailure('putting a touched actor back at rest', e);
            }
        }
        this._touched.clear();
        for (const [actor, id] of this._endWatchers) {
            try {
                actor.disconnect(id);
            } catch (e) {
                logFailure('disconnecting a destroy watcher', e);
            }
        }
        this._endWatchers.clear();
    }
}
