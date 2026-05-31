#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const iconPath = resolve('src-tauri/icons/icon.png');

// 1x1 transparent PNG. This is a feasibility placeholder only.
// The production packaging tranche must replace this with the real icon set.
const transparentPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

await mkdir(dirname(iconPath), { recursive: true });
await writeFile(iconPath, Buffer.from(transparentPngBase64, 'base64'));
console.log(`Ensured Tauri feasibility icon at ${iconPath}`);
