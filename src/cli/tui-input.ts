import { PassThrough } from 'node:stream';
import { emitKeypressEvents } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';

/** Strip SGR mouse reports before readline sees them, including split reports. */
export class TerminalInput {
  readonly keyboard = new PassThrough();
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private timer?: NodeJS.Timeout;
  constructor(private mouse: (button: number, x: number, y: number, released: boolean) => void) { emitKeypressEvents(this.keyboard); }
  feed = (chunk: Buffer | string) => {
    clearTimeout(this.timer);
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    while (this.pending) {
      const start = this.pending.indexOf('\x1b');
      if (start < 0) { this.keyboard.write(this.pending); this.pending = ''; break; }
      if (start > 0) { this.keyboard.write(this.pending.slice(0, start)); this.pending = this.pending.slice(start); }
      const report = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.pending);
      if (report) {
        this.pending = this.pending.slice(report[0].length);
        this.mouse(Number(report[1]), Number(report[2]) - 1, Number(report[3]) - 1, report[4] === 'm');
      } else if (['\x1b', '\x1b['].includes(this.pending) || /^\x1b\[<[\d;]*$/.test(this.pending)) {
        this.timer = setTimeout(() => { const text = this.pending; this.pending = ''; if (!text.startsWith('\x1b[<')) this.keyboard.write(text); }, 40);
        break;
      } else { this.keyboard.write(this.pending[0]); this.pending = this.pending.slice(1); }
    }
  };
  close() { clearTimeout(this.timer); this.keyboard.destroy(); }
}
