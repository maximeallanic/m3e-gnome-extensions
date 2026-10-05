// Core engine scenarios about state and lifecycle: settings, unmapped actors, take-over, destruction, Clutter
// and GLSL API probes.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {wait, waitUntil} from '../tools.js';
import {engine, newActor, withSetting} from './engine-model.js';

const glslErrors = [];

// Trivial GLSL effect with a float uniform (checks the Shell.GLSLEffect API).
const ProbeEffect = GObject.registerClass(
class M3eBenchProbeEffect extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        // An exception in a vfunc is only logged: we keep it.
        try {
            this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
                'uniform float m3e_gain;',
                'cogl_color_out.rgb *= m3e_gain;',
                false);
        } catch (e) {
            glslErrors.push(`${e}`);
        }
    }

    _init() {
        super._init();
        this._location = this.get_uniform_location('m3e_gain');
    }

    setGain(v) {
        this.set_uniform_float(this._location, 1, [v]);
    }
});

export const engineStateScenarios = {
    // Why would the nested Shell's animations be turned off?
    // (Main._shouldEnableAnimations: software rendering, remote access, VNC.)
    animations: async () => {
        const st = St.Settings.get();
        const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const detail = {
            enableAnimations: st.enable_animations,
            settingsKey: settings.get_boolean('enable-animations'),
            forceAnimations: global.force_animations,
            hardwareAccelerated: global.backend.is_rendering_hardware_accelerated(),
            slowDownFactor: st.slow_down_factor,
        };
        return {type: 'state', ok: detail.enableAnimations, detail};
    },

    // enable-animations=false: final value at the first frame, onDone called. The setting is written in the
    // nested Shell's PRIVATE dconf database (nested.sh).
    'no-animations': async scene => {
        const {animate} = await engine();
        const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const keyBefore = settings.get_boolean('enable-animations');
        const stBefore = St.Settings.get().enable_animations;
        return withSetting(
            async () => {
                settings.set_boolean('enable-animations', false);
                Gio.Settings.sync();
                await waitUntil(() => !St.Settings.get().enable_animations, 2000);
            },
            async () => {
                settings.set_boolean('enable-animations', keyBefore);
                Gio.Settings.sync();
                return waitUntil(() => St.Settings.get().enable_animations === stBefore &&
                    settings.get_boolean('enable-animations') === keyBefore, 5000);
            },
            async () => {
                const disabled = !St.Settings.get().enable_animations;
                const actor = newActor(scene, {width: 60});
                await scene.waitFrames(1);
                let doneCalls = 0;
                const anim = animate(actor, {translation_x: 400, opacity: 100},
                    {spring: 'Default', onDone: () => doneCalls++});
                const syncDone = doneCalls;
                const running = anim.running;
                actor.queue_redraw();
                const [first] = await scene.sample(actor, ['translation_x', 'opacity'],
                    {elapsed: () => null, until: scene.waitFrames(1)});
                await wait(50);
                actor.destroy();
                const ok = disabled && syncDone === 0 && first?.values.translation_x === 400 &&
                    first?.values.opacity === 100 && doneCalls === 1 && !running;
                return {type: 'state', ok, detail: {keyBefore, stBefore, disabled, first, doneCalls, syncDone, running}};
            });
    },

    // Actor not shown: final value at once, onDone called (idle), nothing running.
    'not-mapped': async scene => {
        const {animate, _diagnostic} = await engine();
        const parent = new St.Widget({visible: false});
        scene.container.add_child(parent);
        const actor = newActor(scene, {parent});
        let doneCalls = 0;
        const anim = animate(actor, {translation_x: 400, opacity: 100},
            {spring: 'Default', onDone: () => doneCalls++});
        const after = {translation_x: actor.translation_x, opacity: actor.opacity,
            running: anim.running, syncDone: doneCalls, mapped: actor.mapped};
        await wait(50);
        const diag = _diagnostic();
        parent.destroy();
        const ok = after.translation_x === 400 && after.opacity === 100 && !after.running &&
            after.syncDone === 0 && doneCalls === 1 && diag.actors === 0;
        return {type: 'state', ok, detail: {after, doneCalls, diagnostic: diag}};
    },

    // Take-over of a property whose onDone still waits for its idle: A set its value at once (unmapped actor, or
    // distance under the threshold), B takes the same property before the idle -> A's onDone never called, B finishes.
    'retarget-pending-done': async scene => {
        const {animate, _diagnostic} = await engine();
        const cases = {};
        // 1. Actor not shown.
        const parent = new St.Widget({visible: false});
        scene.container.add_child(parent);
        const hidden = newActor(scene, {parent});
        const f1 = {a: 0, b: 0};
        animate(hidden, {translation_x: 400}, {spring: 'Default', onDone: () => f1.a++});
        animate(hidden, {translation_x: 100}, {spring: 'Default', onDone: () => f1.b++});
        await wait(50);
        cases.notMapped = {doneA: f1.a, doneB: f1.b, value: hidden.translation_x};
        parent.destroy();
        // 2. Actor shown, A under the threshold (0.3 px), B really starts.
        const actor = newActor(scene, {width: 450});
        await scene.waitFrames(1);
        const f2 = {a: 0, b: 0};
        let resolve;
        const doneB = new Promise(r => { resolve = r; });
        animate(actor, {translation_x: 0.3}, {spring: 'Default', onDone: () => f2.a++});
        animate(actor, {translation_x: 200}, {spring: 'Default', onDone: () => { f2.b++; resolve(); }});
        await Promise.race([doneB, wait(3000)]);
        await wait(50);
        cases.underThreshold = {doneA: f2.a, doneB: f2.b, value: actor.translation_x};
        actor.destroy();
        const diagnostic = _diagnostic();
        const ok = cases.notMapped.doneA === 0 && cases.notMapped.doneB === 1 &&
            cases.notMapped.value === 100 && cases.underThreshold.doneA === 0 &&
            cases.underThreshold.doneB === 1 && cases.underThreshold.value === 200 &&
            diagnostic.actors === 0 && diagnostic.pendingDone === 0;
        return {type: 'state', ok, detail: {...cases, diagnostic}};
    },

    // Actor destroyed mid-animation: no onDone, state cleaned, API inert.
    destroy: async scene => {
        const {animate, currentState, _diagnostic} = await engine();
        const actor = newActor(scene, {width: 450});
        await scene.waitFrames(1);
        let doneCalls = 0, alive = true;
        const anim = animate(actor, {translation_x: 400, opacity: 120},
            {spring: 'Default', onDone: () => doneCalls++});
        // Sampled through a proxy: never reads the actor once destroyed.
        const proxy = {get translation_x() { return alive ? actor.translation_x : null; }};
        const samples = await scene.sample(proxy, ['translation_x'],
            {elapsed: () => anim.timing('translation_x').elapsed,
                until: Promise.race([scene.waitFrames(5), wait(1000)])});
        const beforeDestroy = currentState(actor, 'translation_x');
        const diagBefore = _diagnostic();
        alive = false;
        actor.destroy();
        const after = {running: anim.running, state: currentState(actor, 'translation_x'),
            diagnostic: _diagnostic()};
        let apiError = null;
        try {
            anim.retarget({translation_x: 0});
            anim.stop();
            anim.finish();
        } catch (e) {
            apiError = `${e}`;
        }
        await wait(300);
        const ok = doneCalls === 0 && !after.running && after.state === null &&
            after.diagnostic.actors === 0 && after.diagnostic.tracks === 0 && apiError === null &&
            beforeDestroy !== null && samples.length >= 5;
        return {type: 'state', ok, detail: {doneCalls, before: beforeDestroy, diagnosticBefore: diagBefore, after,
            apiError, frames: samples.length}};
    },

    // Does Clutter's interpolation extrapolate when progress exceeds 1? Three measurements:
    //  1. JS progress_func: the API we would like (progress up to 1.2). Under GJS the callback's return value
    //     (double) is lost (read as an integer): detected deterministically with Timeline.advance().
    //  2. interpolation on real frames with an overshooting mode (EASE_OUT_BACK, progress > 1) on translation-x 0 -> 100.
    //  3. Interval.compute(1.2) directly.
    extrapolation: async scene => {
        const tl = new Clutter.Timeline({duration: 1000});
        tl.set_progress_func((t, el, tot) => 0.5 * el / tot);
        tl.advance(1000);
        const progressFuncJs = {expected: 0.5, got: tl.get_progress()};
        progressFuncJs.usable = Math.abs(progressFuncJs.got - 0.5) < 1e-6;

        const actor = new St.Widget({width: 40, height: 40, style: 'background-color: red;'});
        scene.container.add_child(actor);
        const transition = new Clutter.PropertyTransition({
            property_name: 'translation-x',
            interval: new Clutter.Interval({value_type: GObject.TYPE_FLOAT, initial: 0, final: 100}),
            duration: 1000,
            progress_mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        let finish = null;
        const stopped = new Promise(r => { finish = r; });
        transition.connect('stopped', () => finish());
        actor.add_transition('bench-extrapolation', transition);
        const guard = wait(3000);
        const samples = await scene.sample(actor, ['translation_x'], {
            elapsed: () => transition.get_elapsed_time(),
            until: Promise.race([stopped, guard]),
        });
        const maxX = Math.max(...samples.map(e => e.values.translation_x));
        actor.destroy();

        const interval = new Clutter.Interval({value_type: GObject.TYPE_FLOAT, initial: 0, final: 100});
        let compute12 = null;
        try {
            compute12 = interval.compute(1.2);
        } catch (e) {
            compute12 = `unavailable: ${e.message}`;
        }
        const extrapolates = maxX > 105 && (typeof compute12 !== 'number' || Math.abs(compute12 - 120) < 0.01);
        return {type: 'state', ok: true, detail: {maxX, extrapolates, compute12, progressFuncJs,
            frames: samples.length, samples: samples.filter((_, i) => i % 6 === 0).slice(0, 12)}};
    },

    // Shell.GLSLEffect: creation, uniform, 5 frames without exception.
    glsl: async scene => {
        const actor = new St.Widget({width: 40, height: 40, style: 'background-color: red;'});
        scene.container.add_child(actor);
        const effect = new ProbeEffect();
        actor.add_effect(effect);
        let ok = true, error = null;
        try {
            for (let i = 0; i < 5; i++) {
                effect.setGain(1.0 - i * 0.1);
                actor.queue_redraw();
                await scene.waitFrames(1);
            }
        } catch (e) {
            ok = false;
            error = `${e}`;
        }
        actor.destroy();
        if (glslErrors.length) {
            ok = false;
            error = glslErrors.join(' ; ');
        }
        return {type: 'state', ok, detail: {error}};
    },
};
