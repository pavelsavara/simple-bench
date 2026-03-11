// ── Shared Logging Helpers ───────────────────────────────────────────────────

export function banner(msg: string): void {
    console.error(`\n\x1b[1;36m═══ ${msg} ═══\x1b[0m`);
}

export function info(msg: string): void {
    console.error(`\x1b[0;32m▶ ${msg}\x1b[0m`);
}

export function err(msg: string): void {
    console.error(`\x1b[0;31m✗ ${msg}\x1b[0m`);
}
