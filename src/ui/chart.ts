/*
 * Performance tiles + MIPS sparkline (right panel, Debug tab).
 */
const CHART_WINDOW_MS = 30000;

interface Sample { t: number; mips: number; cycles: number }

export class PerfPanel {
    private samples: Sample[] = [];
    private hoverX: number | null = null;

    constructor(private getCyclesPerUs: () => number) {
        const canvas = document.getElementById('mips-chart') as HTMLCanvasElement;
        canvas.addEventListener('mousemove', (e) => {
            this.hoverX = e.offsetX;
            this.draw();
        });
        canvas.addEventListener('mouseleave', () => { this.hoverX = null; this.draw(); });
        this.draw();
    }

    /** Handle a worker 'status' message; updates all live readouts. */
    record(msg: { mips: string | number; cycles: number; now?: number }) {
        const t = msg.now ?? performance.now();
        const mips = parseFloat(String(msg.mips));
        this.samples.push({ t, mips: Number.isFinite(mips) ? mips : 0, cycles: msg.cycles });
        while (this.samples.length && this.samples[0].t < t - CHART_WINDOW_MS) this.samples.shift();

        const el = (id: string) => document.getElementById(id)!;
        el('mips-display').textContent = `${msg.mips} MIPS`;
        el('cycle-display').textContent = `${this.fmtCycles(msg.cycles)} cycles`;
        el('tile-mips').innerHTML = `${msg.mips}<small>MIPS</small>`;
        el('tile-cycles').textContent = this.fmtCycles(msg.cycles);
        this.updateTiles(msg.cycles);

        // Emulated-vs-wall ratio over the last ~2 s of samples. About 1
        // while the firmware idles (worker paces emulated time to the host
        // clock), below 1 in compute-bound stretches.
        let i = this.samples.length - 1;
        while (i > 0 && this.samples[i - 1].t > t - 2000) i--;
        const first = this.samples[i], last = this.samples[this.samples.length - 1];
        const wallMs = last.t - first.t;
        const cyclesPerUs = this.getCyclesPerUs();
        if (wallMs > 200 && cyclesPerUs > 0) {
            const emuMs = (last.cycles - first.cycles) / cyclesPerUs / 1000;
            const ratio = emuMs / wallMs;
            el('tile-ratio').innerHTML = `${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(2)}<small>×</small>`;
        }
        this.draw();
    }

    updateTiles(cycles: number) {
        const cyclesPerUs = this.getCyclesPerUs();
        const secs = cyclesPerUs > 0 ? cycles / cyclesPerUs / 1e6 : 0;
        document.getElementById('tile-time')!.innerHTML = `${secs.toFixed(3)}<small>s</small>`;
    }

    reset() {
        this.samples.length = 0;
        this.draw();
    }

    private fmtCycles(n: number): string {
        if (n < 1e6) return Math.floor(n).toLocaleString();
        if (n < 1e9) return `${(n / 1e6).toFixed(2)} M`;
        return `${(n / 1e9).toFixed(3)} G`;
    }

    draw() {
        const canvas = document.getElementById('mips-chart') as HTMLCanvasElement | null;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth || 300, cssH = 64;
        if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
        }
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const styles = getComputedStyle(document.documentElement);
        const accent = styles.getPropertyValue('--accent').trim();
        const grid = styles.getPropertyValue('--border').trim();

        const padX = 6, padTop = 8, padBottom = 6;
        const plotW = cssW - padX * 2, plotH = cssH - padTop - padBottom;

        // Recessive gridlines at 1/3 and 2/3.
        ctx.strokeStyle = grid;
        ctx.lineWidth = 1;
        for (const f of [1 / 3, 2 / 3]) {
            const y = padTop + plotH * f + 0.5;
            ctx.beginPath(); ctx.moveTo(padX, y); ctx.lineTo(cssW - padX, y); ctx.stroke();
        }

        const chartMax = document.getElementById('chart-max')!;
        if (this.samples.length < 2) { chartMax.textContent = ''; return; }
        const now = this.samples[this.samples.length - 1].t;
        const t0 = now - CHART_WINDOW_MS;
        let max = 0;
        for (const s of this.samples) if (s.mips > max) max = s.mips;
        max = Math.max(1, max * 1.1);
        chartMax.textContent = `peak ${(max / 1.1).toFixed(1)}`;

        const px = (t: number) => padX + ((t - t0) / CHART_WINDOW_MS) * plotW;
        const py = (v: number) => padTop + plotH - (v / max) * plotH;

        // Area fill under the line, then the 2px line on top.
        ctx.beginPath();
        ctx.moveTo(px(this.samples[0].t), py(0));
        for (const s of this.samples) ctx.lineTo(px(s.t), py(s.mips));
        ctx.lineTo(px(now), py(0));
        ctx.closePath();
        const fill = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
        fill.addColorStop(0, 'rgba(255, 122, 26, 0.35)');
        fill.addColorStop(1, 'rgba(255, 122, 26, 0.02)');
        ctx.fillStyle = fill;
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i < this.samples.length; i++) {
            const s = this.samples[i];
            if (i === 0) ctx.moveTo(px(s.t), py(s.mips)); else ctx.lineTo(px(s.t), py(s.mips));
        }
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Hover crosshair + tooltip.
        const tip = document.getElementById('chart-tip')!;
        if (this.hoverX != null) {
            const tHover = t0 + ((this.hoverX - padX) / plotW) * CHART_WINDOW_MS;
            let best = this.samples[0];
            for (const s of this.samples) if (Math.abs(s.t - tHover) < Math.abs(best.t - tHover)) best = s;
            const x = px(best.t), y = py(best.mips);
            ctx.strokeStyle = 'rgba(236, 236, 234, 0.35)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x + 0.5, padTop); ctx.lineTo(x + 0.5, padTop + plotH); ctx.stroke();
            ctx.fillStyle = accent;
            ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#1c1c21'; ctx.lineWidth = 2; ctx.stroke();
            tip.textContent = `${best.mips.toFixed(1)} MIPS · ${((now - best.t) / 1000).toFixed(1)} s ago`;
            tip.style.display = 'block';
            const tipW = tip.offsetWidth;
            tip.style.left = `${Math.min(Math.max(0, x - tipW / 2), cssW - tipW)}px`;
        } else {
            tip.style.display = 'none';
        }
    }
}
