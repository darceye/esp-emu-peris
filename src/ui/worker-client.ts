/*
 * Typed page-side handle on the peris worker. The ONLY module allowed to
 * touch the Worker object; every other UI module sends/receives through it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Msg = any;

export interface MachineInfo {
    chip: string;
    isXtensa: boolean;
    numHarts: number;
    cyclesPerUs: number;
}

export class WorkerClient {
    readonly worker: Worker;
    private handlers = new Set<(msg: Msg) => void>();
    onerror: ((message: string) => void) | null = null;

    constructor(workerUrl = 'build/core/worker.js') {
        this.worker = new Worker(workerUrl, { type: 'module' });
        this.worker.onmessage = (e: MessageEvent) => {
            for (const h of this.handlers) h(e.data);
        };
        this.worker.onerror = (e: ErrorEvent) => {
            this.onerror?.(e.message || String(e));
        };
    }

    send(msg: Msg, transfer?: Transferable[]) {
        if (transfer) this.worker.postMessage(msg, transfer);
        else this.worker.postMessage(msg);
    }

    /** Register a message handler; returns an unsubscribe function. */
    on(fn: (msg: Msg) => void): () => void {
        this.handlers.add(fn);
        return () => this.handlers.delete(fn);
    }

    /** Kick off wasm loading inside the worker (absolute URL for pkg/). */
    initWasm() {
        this.send({ type: 'init', wasmUrl: new URL('pkg/esp_emu.js', document.baseURI).href });
    }
}
