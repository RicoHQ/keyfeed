// Node entry config: reads .env (if present) into process.env, then builds the shared config.
import { readFileSync, existsSync } from 'node:fs';
import { makeConfig } from './settings.js';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const config = makeConfig(process.env);
