import { fileURLToPath } from 'node:url';

// Source and compiled runtime share the same package-owned assets.
const compiled = new URL('../', import.meta.url).pathname.endsWith('/dist/');
export const packageRoot = new URL(compiled ? '../../' : '../', import.meta.url);
export function packageFile(relative: string): URL { return new URL(relative, packageRoot); }
export function webFile(relative: string): URL { return new URL('dist/web/' + relative, packageRoot); }
export const executablePath = fileURLToPath(packageFile('dist/bin/noknok.js'));
