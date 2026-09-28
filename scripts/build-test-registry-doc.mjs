#!/usr/bin/env node
/**
 * Сборка читаемого представления реестра проверок.
 *
 * Реестр — YAML, потому что его читает машина. Человеку нужен текст, и он
 * выводится отсюда: `docs/testing/registry.md`. Руками этот текст не правят —
 * `npm run check:registry` сравнивает его с реестром и краснеет, если файл
 * отстал.
 *
 * Запуск: npm run docs:registry
 */
import YAML from 'yaml';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderRegistryDoc } from './lib/registry-doc.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'docs', 'testing', 'registry.yaml');
const TARGET = join(ROOT, 'docs', 'testing', 'registry.md');

const registry = YAML.parse(readFileSync(REGISTRY, 'utf8'));
const text = renderRegistryDoc(registry);
writeFileSync(TARGET, text, 'utf8');

console.warn(`готово: ${TARGET} (${text.split('\n').length} строк)`);
