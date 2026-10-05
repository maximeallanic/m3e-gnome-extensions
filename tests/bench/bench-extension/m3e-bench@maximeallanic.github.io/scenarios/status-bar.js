// Scenario of the status-bar extension: it patches the quick settings indicators (battery drawing, volume indicator,
// ink-width layout of icons); disable() must hand every actor back to the Shell. A nested headless Shell has no
// battery, so this checks wiring, restoration and re-enabling, not the drawing.
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Checks, checksResult, wait, waitUntil} from '../tools.js';
import {extensionOf, STATUS_BAR} from './under-test.js';

const countBatteryActors = system => system.get_children().filter(a => a.has_style_class_name?.('status-bar-battery')).length;

function layoutManagerNames() {
    const names = [];
    const walk = a => {
        if (a instanceof St.Icon && a.has_style_class_name('system-status-icon'))
            names.push(a.layout_manager.constructor.name);
        a.get_children().forEach(walk);
    };
    walk(Main.panel._rightBox);
    return names;
}

async function statusBarLifecycle() {
    const c = new Checks();
    const ext = extensionOf(STATUS_BAR).stateObj;
    const qs = Main.panel.statusArea.quickSettings;
    const ready = await waitUntil(() => qs._system && qs._volumeOutput, 10000);
    c.ok('quick settings indicators exist', !!ready);
    const system = qs._system;
    await wait(500);
    c.ok('enabled: exactly one battery actor', countBatteryActors(system) === 1, `${countBatteryActors(system)}`);
    ext.disable();
    await wait(200);
    c.ok('disabled: battery actor destroyed', countBatteryActors(system) === 0, `${countBatteryActors(system)}`);
    c.ok('disabled: system indicator visible again (Shell rule without a battery)', system._indicator.visible);
    // Without the Material-Symbols icon theme no icon carries an ink width, so none is wrapped even while enabled.
    c.ok('disabled: no ink-width layout manager left', layoutManagerNames().every(n => !/InkWidth/.test(n)),
        JSON.stringify([...new Set(layoutManagerNames())]));
    const volumeVisible = qs._volumeOutput._indicator.visible;
    c.ok('disabled: volume indicator follows the Shell rule (visible iff the stream has an icon)',
        volumeVisible === (qs._volumeOutput._output.getIcon() !== null), `${volumeVisible}`);
    await ext.enable();
    await wait(500);
    c.ok('re-enabled: exactly one battery actor', countBatteryActors(system) === 1, `${countBatteryActors(system)}`);
    ext.disable();
    await ext.enable();
    await wait(300);
    c.ok('repeated disable/enable: still one battery actor', countBatteryActors(system) === 1,
        `${countBatteryActors(system)}`);
    return checksResult(c);
}

export const statusBarScenarios = {
    'status-bar-lifecycle': statusBarLifecycle,
};
