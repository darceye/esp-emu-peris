/*
 * Message protocol between the page and the peris worker (v1).
 * These ride on the same postMessage channel as the stock worker protocol.
 */
export const PERIS_API_VERSION = 1;

// page -> worker
export const PERIS_CONFIG = 'peris_config';   // { config } apply a full config
export const PERIS_COMMAND = 'peris_command'; // { id, cmd, params } view -> device

// worker -> page
export const PERIS_READY = 'peris_ready';     // { ok, errors, devices }
export const PERIS_STATE = 'peris_state';     // { id, state } device state update
export const PERIS_LOG = 'peris_log';         // { level, text }

// Config file shape (also the localStorage shape):
// {
//   perisVersion: 1,
//   chip: 'esp32c3',
//   devices: [ { id, type, ...deviceConfig } ]
// }
