/*
 * UART0 console (xterm). Owns the byte counter; firmware input is handed
 * to a callback registered by the app.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const Terminal: any;
declare const FitAddon: any;

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / 1048576).toFixed(2)} MiB`;
}

export function formatCycles(n: number): string {
    if (n < 1e6) return Math.floor(n).toLocaleString();
    if (n < 1e9) return `${(n / 1e6).toFixed(2)} M`;
    return `${(n / 1e9).toFixed(3)} G`;
}

export class TerminalView {
    readonly term: any;
    private fitAddon: any;
    private uartBytes = 0;
    private countEl = document.getElementById('uart-count')!;

    constructor(container: HTMLElement) {
        this.term = new Terminal({
            theme: {
                background: '#0e0e10',
                foreground: '#ececea',
                cursor: '#ff7a1a',
                cursorAccent: '#0e0e10',
                selectionBackground: 'rgba(255, 122, 26, 0.3)',
                black: '#1c1c21', brightBlack: '#5c5c66',
                red: '#ff5c5c', brightRed: '#ff7b7b',
                green: '#49d49a', brightGreen: '#6ee7b7',
                yellow: '#f5c04a', brightYellow: '#ffd57a',
                blue: '#6ea8fe', brightBlue: '#9cc2ff',
                magenta: '#d48cff', brightMagenta: '#e3b0ff',
                cyan: '#4cd3e0', brightCyan: '#7fe3ee',
                white: '#ececea', brightWhite: '#ffffff',
            },
            fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
            fontSize: 13,
            lineHeight: 1.15,
            convertEol: true,
            cursorBlink: true,
            scrollback: 10000,
        });
        this.fitAddon = new FitAddon.FitAddon();
        this.term.loadAddon(this.fitAddon);
        this.term.open(container);
        this.fitAddon.fit();
        this.countEl.textContent = '0 B';
    }

    /** Terminal keystrokes -> UART RX bytes. */
    onData(cb: (bytes: number[]) => void) {
        this.term.onData((data: string) => {
            cb(Array.from(new TextEncoder().encode(data)));
        });
    }

    fit() {
        this.fitAddon?.fit();
    }

    write(s: string) {
        this.term.write(s);
    }

    writeln(s: string) {
        this.term.writeln(s);
    }

    /** Firmware UART output + byte counter update. */
    uartOut(text: string) {
        this.term.write(text);
        this.uartBytes += text.length;
        this.countEl.textContent = formatBytes(this.uartBytes);
    }

    resetCounter() {
        this.uartBytes = 0;
        this.countEl.textContent = '0 B';
    }

    clear() {
        this.term.clear();
    }

    banner() {
        this.writeln('\x1b[1;33m╔══════════════════════════════════════╗');
        this.writeln('║  ESP-EMU + PERIS peripherals v0.51.0 ║');
        this.writeln('║  Load a firmware .bin to begin       ║');
        this.writeln('╚══════════════════════════════════════╝\x1b[0m');
        this.writeln('');
    }
}
