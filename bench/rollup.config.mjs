import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';

export default {
    input: 'src/main.ts',
    output: {
        file: '../artifacts/bench/bench.mjs',
        format: 'es',
        sourcemap: true,
    },
    plugins: [
        resolve(),
        typescript({ tsconfig: './tsconfig.json', outDir: '../artifacts/bench' }),
    ],
    external: [
        'node:child_process',
        'node:fs',
        'node:fs/promises',
        'node:http',
        'node:os',
        'node:path',
        'node:process',
        'node:url',
        'node:util',
        'playwright',
    ],
};
