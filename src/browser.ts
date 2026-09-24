import { spawn } from 'node:child_process';

export type BrowserOptions = { browser?: boolean; 'no-browser'?: boolean };
export function browserAvailable(env = process.env, platform = process.platform): boolean {
  return !env.SSH_CONNECTION && !env.SSH_TTY && !env.SSH_CLIENT && (platform === 'darwin' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY));
}
export async function showDestination(url: string, options: BrowserOptions, launch = launchBrowser, output = console.log, available = browserAvailable()): Promise<void> {
  const target = new URL(url);
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid browser destination.');
  if (options.browser && options['no-browser']) throw new Error('Choose --browser or --no-browser, not both.');
  if (!options.browser) output(url);
  if (options['no-browser'] || (!options.browser && !available)) return;
  if (!await launch(url)) { if (options.browser) output(url); output('Could not open a browser. Open the URL on your laptop or phone.'); }
}
function launchBrowser(url: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 3000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('exit', code => { clearTimeout(timer); resolve(code === 0); });
  });
}
