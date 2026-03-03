/**
 * Interactive timeline range selector.
 * Displays a horizontal bar showing the full data range with a draggable window
 * to select the visible date range. Supports preset buttons and mouse-wheel zoom.
 */

const PRESETS = [
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
    { label: '1y', days: 365 },
    { label: 'All', days: 0 }
];

export class Timeline {
    #container;
    #bar;
    #window;
    #presetBar;
    #changeCallbacks;

    /** Full data extent (Date objects). */
    #dataMin;
    #dataMax;

    /** Currently visible window (Date objects). */
    #viewMin;
    #viewMax;

    /** Drag state. */
    #dragging;

    /** Reset callback. */
    #onReset;

    constructor(container) {
        this.#container = container;
        this.#changeCallbacks = [];
        this.#dragging = null;
        this.#dataMin = null;
        this.#dataMax = null;
        this.#viewMin = null;
        this.#viewMax = null;

        this.#build();
        this.#attachEvents();
    }

    #build() {
        // Preset buttons row
        this.#presetBar = document.createElement('div');
        this.#presetBar.className = 'timeline-presets';

        // Home/reset button
        const homeBtn = document.createElement('button');
        homeBtn.className = 'timeline-preset-btn timeline-home-btn';
        homeBtn.title = 'Reset zoom to default (90 days)';
        homeBtn.innerHTML = '&#8962;'; // ⌂ house icon
        homeBtn.addEventListener('click', () => this.#onReset?.());
        this.#presetBar.appendChild(homeBtn);

        for (const p of PRESETS) {
            const btn = document.createElement('button');
            btn.className = 'timeline-preset-btn';
            btn.textContent = p.label;
            btn.dataset.days = p.days;
            btn.addEventListener('click', () => this.#applyPreset(p.days));
            this.#presetBar.appendChild(btn);
        }
        this.#container.appendChild(this.#presetBar);

        // The track bar
        this.#bar = document.createElement('div');
        this.#bar.className = 'timeline-bar';

        // The draggable window inside the bar
        this.#window = document.createElement('div');
        this.#window.className = 'timeline-window';
        this.#bar.appendChild(this.#window);
        this.#container.appendChild(this.#bar);
    }

    #attachEvents() {
        // Drag the window to pan
        this.#window.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            this.#window.setPointerCapture(e.pointerId);
            const barRect = this.#bar.getBoundingClientRect();
            const winLeft = this.#window.offsetLeft;
            this.#dragging = { startX: e.clientX, startLeft: winLeft, barWidth: barRect.width };
        });

        this.#window.addEventListener('pointermove', (e) => {
            if (!this.#dragging) return;
            const dx = e.clientX - this.#dragging.startX;
            this.#panByPixels(this.#dragging.startLeft + dx, this.#dragging.barWidth);
        });

        const stopDrag = () => {
            if (this.#dragging) {
                this.#dragging = null;
                this.#notifyChange();
            }
        };
        this.#window.addEventListener('pointerup', stopDrag);
        this.#window.addEventListener('pointercancel', stopDrag);

        // Wheel zoom on the bar
        this.#bar.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.#zoomByWheel(e);
        }, { passive: false });
    }

    /** Set the full data extent. Call once after loading the index. */
    setDataExtent(minDate, maxDate) {
        this.#dataMin = new Date(minDate);
        this.#dataMax = new Date(maxDate);
        if (this.#viewMin == null) {
            this.#viewMin = new Date(this.#dataMin);
            this.#viewMax = new Date(this.#dataMax);
        }
        this.#render();
    }

    /** Set the visible range (e.g. from chart zoom callback). */
    setViewRange(minDate, maxDate) {
        this.#viewMin = new Date(minDate);
        this.#viewMax = new Date(maxDate);
        this.#clamp();
        this.#render();
    }

    /** Get the current view range as { min: string, max: string } ISO date strings. */
    getRange() {
        if (!this.#viewMin || !this.#viewMax) return { min: null, max: null };
        return {
            min: this.#toDateStr(this.#viewMin),
            max: this.#toDateStr(this.#viewMax)
        };
    }

    /** Is the full range selected? */
    isFullRange() {
        if (!this.#dataMin || !this.#viewMin) return true;
        return this.#viewMin <= this.#dataMin && this.#viewMax >= this.#dataMax;
    }

    onChange(callback) {
        this.#changeCallbacks.push(callback);
    }

    /** Register a callback for the home/reset button. */
    onReset(callback) {
        this.#onReset = callback;
    }

    #notifyChange() {
        for (const cb of this.#changeCallbacks) cb(this.getRange());
    }

    #applyPreset(days) {
        if (!this.#dataMax) return;
        if (days === 0) {
            this.#viewMin = new Date(this.#dataMin);
            this.#viewMax = new Date(this.#dataMax);
        } else {
            this.#viewMax = new Date(this.#dataMax);
            this.#viewMin = new Date(this.#dataMax.getTime() - days * 86400000);
            if (this.#viewMin < this.#dataMin) this.#viewMin = new Date(this.#dataMin);
        }
        this.#render();
        this.#highlightPreset(days);
        this.#notifyChange();
    }

    #highlightPreset(days) {
        for (const btn of this.#presetBar.querySelectorAll('.timeline-preset-btn')) {
            btn.classList.toggle('active', parseInt(btn.dataset.days) === days);
        }
    }

    #panByPixels(newLeft, barWidth) {
        if (!this.#dataMin || !this.#dataMax) return;
        const totalMs = this.#dataMax.getTime() - this.#dataMin.getTime();
        const windowMs = this.#viewMax.getTime() - this.#viewMin.getTime();
        const windowFrac = windowMs / totalMs;
        const maxLeft = barWidth * (1 - windowFrac);

        const clampedLeft = Math.max(0, Math.min(newLeft, maxLeft));
        const frac = clampedLeft / barWidth;

        this.#viewMin = new Date(this.#dataMin.getTime() + frac * totalMs);
        this.#viewMax = new Date(this.#viewMin.getTime() + windowMs);
        this.#clamp();
        this.#render();
        this.#clearPresetHighlight();
    }

    #zoomByWheel(e) {
        if (!this.#dataMin || !this.#dataMax) return;
        const totalMs = this.#dataMax.getTime() - this.#dataMin.getTime();
        const windowMs = this.#viewMax.getTime() - this.#viewMin.getTime();

        // Zoom factor: scroll up = zoom in, scroll down = zoom out
        const factor = e.deltaY > 0 ? 1.3 : 0.7;
        let newWindowMs = windowMs * factor;

        // Minimum 2 days, maximum full range
        const minMs = 2 * 86400000;
        newWindowMs = Math.max(minMs, Math.min(newWindowMs, totalMs));

        // Keep center stable
        const center = (this.#viewMin.getTime() + this.#viewMax.getTime()) / 2;
        this.#viewMin = new Date(center - newWindowMs / 2);
        this.#viewMax = new Date(center + newWindowMs / 2);
        this.#clamp();
        this.#render();
        this.#clearPresetHighlight();
        this.#notifyChange();
    }

    #clamp() {
        if (!this.#dataMin || !this.#dataMax) return;
        const windowMs = this.#viewMax.getTime() - this.#viewMin.getTime();
        if (this.#viewMin < this.#dataMin) {
            this.#viewMin = new Date(this.#dataMin);
            this.#viewMax = new Date(this.#dataMin.getTime() + windowMs);
        }
        if (this.#viewMax > this.#dataMax) {
            this.#viewMax = new Date(this.#dataMax);
            this.#viewMin = new Date(this.#dataMax.getTime() - windowMs);
        }
        if (this.#viewMin < this.#dataMin) {
            this.#viewMin = new Date(this.#dataMin);
        }
    }

    #clearPresetHighlight() {
        for (const btn of this.#presetBar.querySelectorAll('.timeline-preset-btn')) {
            btn.classList.remove('active');
        }
    }

    #render() {
        if (!this.#dataMin || !this.#dataMax || !this.#viewMin || !this.#viewMax) return;
        const totalMs = this.#dataMax.getTime() - this.#dataMin.getTime();
        if (totalMs <= 0) {
            this.#window.style.left = '0%';
            this.#window.style.width = '100%';
            return;
        }
        const leftFrac = (this.#viewMin.getTime() - this.#dataMin.getTime()) / totalMs;
        const widthFrac = (this.#viewMax.getTime() - this.#viewMin.getTime()) / totalMs;
        this.#window.style.left = `${(leftFrac * 100).toFixed(2)}%`;
        this.#window.style.width = `${(widthFrac * 100).toFixed(2)}%`;
    }

    #toDateStr(d) {
        return d.toISOString().slice(0, 10);
    }
}

export { PRESETS };
