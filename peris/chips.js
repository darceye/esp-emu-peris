/*
 * Per-chip GPIO facts, shared by the page and the worker.
 * Mirrors app.js of the stock esp-emulator-browser UI.
 */
export const GPIO_COUNT = {
    esp32c3: 22, esp32c5: 29, esp32c6: 31, esp32h2: 28,
    esp32p4: 55, esp32s3: 49, esp32s31: 32,
};
export const GPIO_ABSENT = { esp32s3: new Set([22, 23, 24, 25]) };

export function gpioCount(chip) {
    return GPIO_COUNT[chip] || 32;
}
export function validPins(chip) {
    const n = gpioCount(chip);
    const absent = GPIO_ABSENT[chip] || new Set();
    const out = [];
    for (let i = 0; i < n; i++) if (!absent.has(i)) out.push(i);
    return out;
}
