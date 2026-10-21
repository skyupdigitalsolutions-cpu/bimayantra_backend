// The compiled server runs migrations from dist/drizzle (copied from ./drizzle at build time)
import { cpSync } from 'node:fs';
cpSync('drizzle', 'dist/drizzle', { recursive: true });
cpSync('src/messages/messages.json', 'dist/messages/messages.json');
cpSync('src/assets', 'dist/assets', { recursive: true });
