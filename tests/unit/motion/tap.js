// Minimal TAP helper for the motion unit tests (run with `gjs -m <file>`).
import System from 'system';

let count = 0;
let failures = 0;

export function ok(condition, name) {
    count++;
    if (condition) {
        print(`ok ${count} - ${name}`);
    } else {
        failures++;
        print(`not ok ${count} - ${name}`);
    }
}

export const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export function done() {
    print(`1..${count}`);
    if (failures)
        System.exit(1);
}
