// Volume: like the Android status bar, the indicator only shows while the output is silent (muted or zero volume).
// The Shell makes the icon visible again on every stream update, so we hide it again right behind it.
import {whenIndicator} from './quick-settings.js';

export const NAME = 'volume';

let cancelWait = null;
let state = null;

function isSilent(slider) {
    const stream = slider._stream;
    return Boolean(stream) && (stream.is_muted || stream.volume <= 0);
}

function apply() {
    const {icon, slider} = state;
    // The Shell hides the icon itself without a stream or a ready mixer: we never make it visible.
    if (icon.visible && !isSilent(slider))
        icon.hide();
}

export function enable() {
    cancelWait = whenIndicator('_volumeOutput', output => {
        state = {icon: output._indicator, slider: output._output};
        state.streamId = state.slider.connect('stream-updated', apply);
        state.visibleId = state.icon.connect('notify::visible', apply);
        apply();
    });
}

export function disable() {
    cancelWait?.();
    cancelWait = null;
    if (!state)
        return;
    const {icon, slider} = state;
    slider.disconnect(state.streamId);
    icon.disconnect(state.visibleId);
    // Shell rule (status/volume.js, OutputIndicator): visible as soon as there is a stream icon.
    icon.visible = slider.getIcon() !== null;
    state = null;
}
