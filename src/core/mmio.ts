/*
 * MMIO register maps per chip. Used by register-level devices (PWM LED in
 * M2, WS2812 in M3) via ctx.readU32. Add a chip by adding a data module
 * here — nothing else changes.
 */
import type { ChipMmio } from './mmio/c3.js';
import { esp32c3 } from './mmio/c3.js';

export type { ChipMmio };

const MAPS: Record<string, ChipMmio> = {
    esp32c3,
};

export function mmioFor(chip: string): ChipMmio | null {
    return MAPS[chip] ?? null;
}

/** GPIO_FUNCn_OUT_SEL_CFG address for a pad (routing discovery). */
export function funcOutSelAddr(mmio: ChipMmio, pin: number): number {
    return mmio.gpio.funcOutSelBase + mmio.gpio.funcOutSelStride * pin;
}

/** IO_MUX pad register address (GPIO0..11 on C3; others vary per chip). */
export function ioMuxAddr(mmio: ChipMmio, pin: number): number | null {
    if (pin < 0 || pin > 11) return null; // C3 low pins only, see FEASIBILITY
    return mmio.ioMux.base + mmio.ioMux.pinBase + mmio.ioMux.pinStride * pin;
}
