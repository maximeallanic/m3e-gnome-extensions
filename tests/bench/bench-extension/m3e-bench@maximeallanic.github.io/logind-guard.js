// Cuts the nested Shell's link to the REAL login session. The nested Shell watches the real session
// (LoginManager.getCurrentSessionProxy, "Will monitor session ..." in shell.log) and ScreenShield._setLocked()
// writes LockedHint there. Without this guard, a Lock/Unlock of the real session would lock/unlock the nested
// Shell, and a nested lock would write LockedHint on the real session.
//   a) at once: _setLocked is replaced on the instance (no SetLockedHint is ever sent);
//   b) as soon as ScreenShield's asynchronous _getLoginSession() has resolved: the JS "Lock" and "Unlock"
//      handlers of the proxy are removed and _loginSession is set to null (for good: the nested Shell is
//      disposable).
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {waitUntil} from './tools.js';

let guard = null;
let retryId = 0;
let stopped = false;

function setLockedWithoutLogind(locked) {
    const before = this._isLocked;
    this._isLocked = locked;
    if (before !== locked)
        this.emit('locked-changed');
}

export function stopLogindGuard() {
    stopped = true;
    if (retryId)
        GLib.source_remove(retryId);
    retryId = 0;
}

export function startLogindGuard() {
    if (guard)
        return guard;
    const shield = Main.screenShield;
    if (!shield)
        return Promise.resolve(null);
    if (shield._bench)
        return Promise.resolve(shield._bench.session);
    shield._setLocked = setLockedWithoutLogind;
    guard = (async () => {
        // _getLoginSession() sets the session after an await: wait for it, otherwise it would be set again
        // (and its Lock/Unlock connected) after our reset to null.
        const session = await waitUntil(() => shield._loginSession, 15000);
        if (!session) {
            console.warn('m3e-bench: login session not resolved in time, retrying (_setLocked already cut)');
            guard = null;
            if (!stopped && !retryId) {
                retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                    retryId = 0;
                    if (!stopped) {
                        startLogindGuard().catch(e =>
                            console.error(`m3e-bench: logind guard: ${e.message}\n${e.stack}`));
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
            return null;
        }
        let cut = 0;
        for (const name of ['Lock', 'Unlock']) {
            for (const id of [...(session._signalConnectionsByName?.[name] ?? [])]) {
                session.disconnectSignal(id);
                cut++;
            }
        }
        shield._bench = {session};
        shield._loginSession = null;
        shield._syncInhibitor();
        console.log(`m3e-bench: nested Shell cut from logind (${cut} Lock/Unlock handler(s) removed)`);
        return session;
    })();
    return guard;
}
