/**
 * Sidebar filter state management with URL hash persistence.
 */
export class Filters {
    #sidebar;
    #state;
    #changeCallbacks;
    #visibleEngines;

    constructor(sidebar) {
        this.#sidebar = sidebar;
        this.#state = { runtime: [], preset: [], profile: [], engine: [], range: { min: null, max: null } };
        this.#changeCallbacks = [];
        this.#visibleEngines = ['v8', 'node', 'chrome', 'firefox'];
    }

    /** Initialize checkboxes from available dimensions + optional initial state from URL hash. */
    init(dimensions, hashState) {
        this.#renderCheckboxGroup('filter-runtime', dimensions.runtimes, hashState?.runtime);
        this.#renderCheckboxGroup('filter-preset', dimensions.presets, hashState?.preset);
        this.#renderCheckboxGroup('filter-profile', dimensions.profiles, hashState?.profile);
        this.#renderCheckboxGroup('filter-engine', dimensions.engines, hashState?.engine);

        if (hashState?.range) {
            this.#state.range = hashState.range;
        }

        this.#readStateFromDOM();

        this.#sidebar.addEventListener('change', () => {
            this.#readStateFromDOM();
            this.#notifyChange();
        });
    }

    #renderCheckboxGroup(containerId, values, selected) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const heading = container.querySelector('h3');
        container.innerHTML = '';
        if (heading) container.appendChild(heading);

        for (const value of values) {
            const label = document.createElement('label');
            label.className = 'filter-option';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.name = containerId.replace('filter-', '');
            checkbox.value = value;
            checkbox.checked = selected ? selected.includes(value) : true;

            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(` ${value}`));
            container.appendChild(label);
        }
    }

    #readStateFromDOM() {
        this.#state = {
            runtime: this.#getCheckedValues('runtime'),
            preset: this.#getCheckedValues('preset'),
            profile: this.#getCheckedValues('profile'),
            engine: this.#getCheckedValues('engine'),
            range: this.#state.range
        };
    }

    #getCheckedValues(name) {
        return Array.from(
            this.#sidebar.querySelectorAll(`input[name="${name}"]:checked`)
        ).map(cb => cb.value);
    }

    /** Show/hide engine checkboxes based on current app. */
    setEngineVisibility(visibleEngines) {
        this.#visibleEngines = visibleEngines;
        const container = document.getElementById('filter-engine');
        if (!container) return;
        for (const label of container.querySelectorAll('.filter-option')) {
            const checkbox = label.querySelector('input');
            const isVisible = visibleEngines.includes(checkbox.value);
            label.style.display = isVisible ? '' : 'none';
            if (!isVisible) checkbox.checked = false;
        }
        this.#readStateFromDOM();
    }

    /** Update the date range from the timeline. */
    setRange(range) {
        this.#state.range = range;
    }

    onChange(callback) {
        this.#changeCallbacks.push(callback);
    }

    #notifyChange() {
        for (const cb of this.#changeCallbacks) cb();
    }

    getState() {
        return { ...this.#state };
    }
}

/** Parse URL hash into filter state object. */
export function readHashState() {
    const hash = location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const rangeParts = params.get('range')?.split(',');
    return {
        app: params.get('app') || 'empty-browser',
        runtime: params.get('runtime')?.split(',') || null,
        preset: params.get('preset')?.split(',') || null,
        profile: params.get('profile')?.split(',') || null,
        engine: params.get('engine')?.split(',') || null,
        range: rangeParts?.length === 2
            ? { min: rangeParts[0], max: rangeParts[1] }
            : { min: null, max: null }
    };
}

/** Write current state to URL hash. */
export function writeHash(app, filterState) {
    const params = new URLSearchParams();
    params.set('app', app);
    if (filterState.runtime.length) params.set('runtime', filterState.runtime.join(','));
    if (filterState.preset.length) params.set('preset', filterState.preset.join(','));
    if (filterState.profile.length) params.set('profile', filterState.profile.join(','));
    if (filterState.engine.length) params.set('engine', filterState.engine.join(','));
    if (filterState.range.min && filterState.range.max) {
        params.set('range', `${filterState.range.min},${filterState.range.max}`);
    }
    history.replaceState(null, '', '#' + params.toString());
}

/** Push state to URL hash (enables back/forward navigation). */
export function pushHash(app, filterState) {
    const params = new URLSearchParams();
    params.set('app', app);
    if (filterState.runtime.length) params.set('runtime', filterState.runtime.join(','));
    if (filterState.preset.length) params.set('preset', filterState.preset.join(','));
    if (filterState.profile.length) params.set('profile', filterState.profile.join(','));
    if (filterState.engine.length) params.set('engine', filterState.engine.join(','));
    if (filterState.range.min && filterState.range.max) {
        params.set('range', `${filterState.range.min},${filterState.range.max}`);
    }
    history.pushState(null, '', '#' + params.toString());
}
