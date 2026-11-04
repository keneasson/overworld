// Lets Node resolve the "@shared/…" alias that Vite provides, so tests can import web modules.
import { register } from 'node:module';

register('./alias-hooks.mjs', import.meta.url);
