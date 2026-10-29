/*
 * MMIO register maps per chip (little-endian, byte addresses). Verified
 * against ESP-IDF soc headers and the running emulator in M0 — see
 * docs/FEASIBILITY.md. Used by register-level devices (PWM LED, WS2812).
 */
import esp32c3 from './mmio/esp32c3.json' with { type: 'json' };

const MAPS = { esp32c3 };

export function mmioFor(chip) {
    return MAPS[chip] || null;
}

/** Resolve a dotted path like 'ledc.ch0.dutyR' to an address. */
export function regAddr(chip, path) {
    const map = mmioFor(chip);
    if (!map) return null;
    let node = map;
    for (const part of path.split('.')) {
        node = node?.[part];
        if (node == null) return null;
    }
    return typeof node === 'number' ? node : null;
}
