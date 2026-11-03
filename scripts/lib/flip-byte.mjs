#!/usr/bin/env node
/**
 * Порча одного байта для испытаний: байт инвертируется, поэтому файл
 * гарантированно меняется (запись «X» поверх совпадала с исходным байтом
 * в 1 случае из 256 — испытание порчи давало ложный провал).
 *
 *   node scripts/lib/flip-byte.mjs <файл> <смещение>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [file, at] = process.argv.slice(2);
const buf = readFileSync(file);
const i = Number(at);
if (!(i >= 0 && i < buf.length)) throw new Error(`смещение ${at} вне файла (${buf.length} байт)`);
buf[i] ^= 0xff;
writeFileSync(file, buf);
