/*
 * Message protocol between the page and the peris worker (v1).
 * These ride on the same postMessage channel as the stock worker protocol
 * (init/load/start/stop/step/reset/uart_input/gpio_input/read_mem/mem_watch/
 * net_connect/net_disconnect/set_batch_size — see worker.ts).
 */
import type { DeviceConfig, PerisConfig } from './types.js';

export const PERIS_API_VERSION = 1;

// ---- page -> worker (peris additions) ----
export const PERIS_CONFIG = 'peris_config';   // { config } apply a full config
export const PERIS_COMMAND = 'peris_command'; // { id, cmd, params } view -> device

export interface PerisConfigMsg { type: typeof PERIS_CONFIG; config: PerisConfig }
export interface PerisCommandMsg { type: typeof PERIS_COMMAND; id: string; cmd: string; params?: Record<string, unknown> }

// ---- worker -> page (peris additions) ----
export const PERIS_READY = 'peris_ready';     // { ok, errors, devices }
export const PERIS_STATE = 'peris_state';     // { id, state } device state update
export const PERIS_LOG = 'peris_log';         // { level, text }

export interface PerisReadyMsg {
    type: typeof PERIS_READY;
    ok: boolean;
    errors: string[];
    devices: Array<{ id: string; type: string; title: string }>;
}
export interface PerisStateMsg { type: typeof PERIS_STATE; id: string; state: Record<string, unknown> }
export interface PerisLogMsg { type: typeof PERIS_LOG; level: 'info' | 'warn' | 'error'; text: string }
export type PerisEvent = PerisReadyMsg | PerisStateMsg | PerisLogMsg;

// Config file shape (also the localStorage shape):
// { perisVersion: 1, chip?: string, devices: [{ id, type, ...settings }] }
export type { PerisConfig, DeviceConfig };
