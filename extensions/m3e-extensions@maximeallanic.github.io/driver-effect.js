// Driver effect: exposes a JS quantity ("position", in logical px) that a spring of the toolkit can drive through
// animate(actor, {'@effects.<name>.position': target}). The effect draws nothing (Clutter.Effect without vfuncs): it
// only carries the callbacks that translate the position into real actor properties (slide-x + dock translation...).
// Why an effect: the toolkit's timeline is attached to the actor (the clock of its monitor) and animate() can write an
// effect property; an actor property could neither bound the value nor spread it over two properties.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

// GTypeName specific to this extension: two extensions registering the same type name make the second one fail.
export const DriverEffect = GObject.registerClass({GTypeName: 'M3eExtensionsDriverEffect'},
class DriverEffect extends Clutter.Effect {
    _init(read, write) {
        super._init();
        this._read = read;
        this._write = write;
    }

    get position() {
        return this._read();
    }

    set position(v) {
        this._write(v);
    }
});
