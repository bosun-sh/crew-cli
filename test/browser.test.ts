import { expect, test } from 'bun:test';
import { browserAvailable, showDestination } from '../src/browser.js';

test('browser destinations print safely on VPS and support explicit overrides', async () => {
  expect(browserAvailable({ SSH_CONNECTION: 'ssh', DISPLAY: ':0' }, 'linux')).toBe(false);
  expect(browserAvailable({}, 'linux')).toBe(false);
  expect(browserAvailable({}, 'darwin')).toBe(true);
  const lines: string[] = []; let calls = 0;
  const launch = async () => { calls++; return true; }; const print = (s: string) => lines.push(s);
  await showDestination('https://crew.bosun.sh/work', {}, launch, print, false);
  expect(calls).toBe(0); expect(lines).toHaveLength(1);
  await showDestination('https://crew.bosun.sh/work', {}, launch, print, true);
  expect(calls).toBe(1); expect(lines).toHaveLength(2);
  await showDestination('https://crew.bosun.sh/work', { browser: true }, launch, print, false);
  expect(calls).toBe(2); expect(lines).toHaveLength(2);
  await showDestination('https://crew.bosun.sh/work', { browser: true }, async () => false, print, false);
  expect(lines).toHaveLength(4);
  await showDestination('https://crew.bosun.sh/work', { 'no-browser': true }, launch, print, true);
  expect(calls).toBe(2);
  await expect(showDestination('https://crew.bosun.sh', { browser: true, 'no-browser': true })).rejects.toThrow('Choose');
});
