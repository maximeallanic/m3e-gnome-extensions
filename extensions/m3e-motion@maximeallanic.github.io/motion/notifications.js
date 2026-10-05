// Notification list of the calendar menu (MessageList.MessageView, GNOME 50):
//   - position pseudo-classes, a contract with the Shell stylesheet of the theme: every visible `.message` actor at
//     the head of a stack (collapsed group: its first message; lone message, media) or in an expanded group is an item
//     of the list; the first item gets `m3e-first`, the last one `m3e-last` (a lone item: both), the other messages
//     none. Updated on add, remove, move, expand;
//   - list motion: when the layout moves an item (add, remove, group expansion...), its displayed place follows the
//     new one on the SystemUI notification spring (PhysicsPropertyAnimator: stiffness 380, damping 0.68, translation
//     Y): the item jumps to its place, a translation equal to the gap brings it back there. The spring is taken over
//     at each new move (displayed position and velocity kept).
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';

import {currentState, release} from '../m3e/animate.js';
import {ANDROID} from '../m3e/tokens.js';
import {Replacements, animationsAllowed} from './utils.js';

export const NAME = 'notifications';

export const FIRST = 'm3e-first';
export const LAST = 'm3e-last';

const replacements = new Replacements();
let view = null;
const connections = new Map(); // object -> [ids]
const marked = new Set(); // messages that carry one of our pseudo-classes
let markPending = 0;

// Connects signal/callback pairs on `object`. The first connection on an object also follows its destruction: the
// entry is dropped (its handlers die with it) and the marks are recomputed.
function connect(object, ...pairs) {
    let ids = connections.get(object);
    if (!ids) {
        ids = [object.connect('destroy', () => {
            connections.delete(object);
            requestMark();
        })];
        connections.set(object, ids);
    }
    for (let i = 0; i < pairs.length; i += 2)
        ids.push(object.connect(pairs[i], pairs[i + 1]));
}

// --- pseudo-classes ----------------------------------------------------------------------------------------------

const isGroup = m => m instanceof MessageList.NotificationMessageGroup;

// Messages of a group in displayed order: [head, cover, ...stack, header] -> head then stack.
function groupMessages(group) {
    const children = group.get_children().filter(c => c !== group._cover && c !== group._headerBox);
    return children.map(c => c.child).filter(m => m instanceof MessageList.Message);
}

// Items of the list, in the order of the view.
export function items(v) {
    const list = [];
    for (const m of v.messages) {
        if (!m.visible)
            continue;
        if (isGroup(m)) {
            const msgs = groupMessages(m).filter(x => x.visible);
            list.push(...(m.expanded ? msgs : msgs.slice(0, 1)));
        } else {
            list.push(m);
        }
    }
    return list;
}

function mark() {
    markPending = 0;
    if (!view)
        return;
    const list = items(view);
    const first = list[0], last = list[list.length - 1];
    const seen = new Set();
    for (const m of list) {
        seen.add(m);
        const set = (pseudoClass, on) => {
            if (on && !m.has_style_pseudo_class(pseudoClass))
                m.add_style_pseudo_class(pseudoClass);
            else if (!on && m.has_style_pseudo_class(pseudoClass))
                m.remove_style_pseudo_class(pseudoClass);
        };
        set(FIRST, m === first);
        set(LAST, m === last);
        if (!marked.has(m)) {
            marked.add(m);
            m._m3eMarkId = m.connect('destroy', () => marked.delete(m));
        }
    }
    for (const m of [...marked]) {
        if (!seen.has(m))
            unmark(m);
    }
}

function unmark(m) {
    marked.delete(m);
    m.disconnect(m._m3eMarkId);
    delete m._m3eMarkId;
    m.remove_style_pseudo_class(FIRST);
    m.remove_style_pseudo_class(LAST);
}

// Grouped update (several signals for one change), before the next frame.
function requestMark() {
    if (!markPending)
        markPending = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            mark();
            return GLib.SOURCE_REMOVE;
        });
}

// --- list motion -------------------------------------------------------------------------------------------------

const SPRING = ANDROID.notifications.spring;

function onAllocation(item) {
    const y = item.get_allocation_box().y1;
    const before = item._m3eY;
    item._m3eY = y;
    requestMark();
    if (before === undefined || Math.abs(y - before) < 0.5 || !animationsAllowed() || !item.mapped)
        return;
    // Displayed place kept: the translation absorbs the jump, the spring brings it back to 0 with the current velocity.
    const e = currentState(item, 'translation_y');
    item._m3eMotion?.stop();
    item.translation_y = (e?.value ?? item.translation_y) + (before - y);
    item._m3eMotion = release(item, 'translation_y', 0, e?.velocity ?? 0, SPRING);
}

function followItem(item) {
    if (connections.has(item))
        return;
    connect(item, 'notify::allocation', () => onAllocation(item));
}

function followGroup(group) {
    if (connections.has(group))
        return;
    connect(group,
        'notify::expanded', requestMark,
        'child-added', (g, c) => {
            followItem(c);
            requestMark();
        },
        'child-removed', requestMark);
    for (const c of group.get_children()) {
        if (c !== group._cover && c !== group._headerBox)
            followItem(c);
    }
}

function followViewChild(item) {
    followItem(item);
    if (isGroup(item.child))
        followGroup(item.child);
    if (item.child)
        connect(item.child, 'notify::visible', requestMark);
}

export function enable() {
    view = Main.panel.statusArea.dateMenu._messageList._messageView;
    connect(view,
        'child-added', (v, item) => {
            if (item.child)
                followViewChild(item);
            requestMark();
        },
        'child-removed', requestMark,
        'notify::expanded-group', requestMark);
    for (const item of view.get_children()) {
        if (item.child)
            followViewChild(item);
    }
    // Move of a message inside a group (urgency): the order changes without add or remove.
    replacements.replace(MessageList.NotificationMessageGroup.prototype, '_updateStackedMessagesFade',
        original => function (...args) {
            const r = original.apply(this, args);
            requestMark();
            return r;
        });
    mark();
}

export function disable() {
    replacements.restore();
    if (markPending)
        GLib.source_remove(markPending);
    markPending = 0;
    for (const [object, ids] of connections) {
        for (const id of ids)
            object.disconnect(id);
        if ('_m3eY' in object) {
            object._m3eMotion?.stop();
            object.translation_y = 0;
            delete object._m3eY;
            delete object._m3eMotion;
        }
    }
    connections.clear();
    for (const m of [...marked])
        unmark(m);
    view = null;
}
