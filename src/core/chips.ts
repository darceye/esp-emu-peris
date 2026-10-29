/*
 * Per-chip GPIO facts, shared by the page and the worker.
 * Mirrors app.js of the stock esp-emulator-browser UI (single source here —
 * do not copy this table elsewhere).
 */
export const GPIO_COUNT: Readonly<Record<string, number>> = {
    esp32c3: 22, esp32c5: 29, esp32c6: 31, esp32h2: 28,
    esp32p4: 55, esp32s3: 49, esp32s31: 32,
};

/** Pins with register slots but no physical pad (S3: 22-25). */
export const GPIO_ABSENT: Readonly<Record<string, ReadonlySet<number>>> = {
    esp32s3: new Set([22, 23, 24, 25]),
};

export function gpioCount(chip: string): number {
    return GPIO_COUNT[chip] ?? 32;
}

export function absentPins(chip: string): ReadonlySet<number> {
    return GPIO_ABSENT[chip] ?? new Set();
}

export function validPins(chip: string): number[] {
    const n = gpioCount(chip);
    const absent = absentPins(chip);
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (!absent.has(i)) out.push(i);
    return out;
}
