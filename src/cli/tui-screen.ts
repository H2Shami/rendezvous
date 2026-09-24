import { displayText } from './agent-events.js';

export const palette = { background: '#111114', panel: '#1a1a20', raised: '#25232b', border: '#39303a', primary: '#df0712', secondary: '#fda4af', text: '#eee9ed', muted: '#9d929d', success: '#b7d3ac' };
type Cell = { text: string; fg: string; bg: string; bold: boolean };
function wide(char: string) { const c = char.codePointAt(0)!; return /\p{Extended_Pictographic}/u.test(char) || (c >= 0x1100 && (c <= 0x115f || c >= 0x2e80 && c <= 0xa4cf || c >= 0xac00 && c <= 0xd7a3 || c >= 0xf900 && c <= 0xfaff || c >= 0xff01 && c <= 0xff60)); }
export function textWidth(text: string) { return [...text].reduce((n, c) => n + (/\p{Mark}/u.test(c) ? 0 : wide(c) ? 2 : 1), 0); }
export class TuiScreen {
  private cells: Cell[][];
  constructor(readonly width: number, readonly height: number) {
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ text: ' ', fg: palette.text, bg: palette.background, bold: false })));
  }
  rect(x: number, y: number, width: number, height: number, bg: string) {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + height); row++) for (let col = Math.max(0, x); col < Math.min(this.width, x + width); col++) Object.assign(this.cells[row][col], { text: ' ', bg, fg: palette.text, bold: false });
  }
  text(x: number, y: number, value: string, fg: string = palette.text, bold = false, max = this.width - x) {
    if (y < 0 || y >= this.height) return;
    let pos = x;
    for (const char of displayText(value).replace(/\n|\t/g, ' ')) {
      if (/\p{Mark}/u.test(char)) { if (pos > x && this.cells[y][pos - 1]) this.cells[y][pos - 1].text += char; continue; }
      const size = wide(char) ? 2 : 1;
      if (pos + size > Math.min(this.width, x + max)) break;
      if (pos >= 0) { Object.assign(this.cells[y][pos], { text: char, fg, bold }); if (size === 2) this.cells[y][pos + 1].text = ''; }
      pos += size;
    }
  }
  wrap(x: number, y: number, value: string, width: number, fg: string = palette.text, limit = 100) {
    let rows = 0;
    for (const paragraph of displayText(value).split('\n')) {
      let line = '';
      for (const char of paragraph) {
        if (textWidth(line + char) > width) { if (rows >= limit) return rows; this.text(x, y + rows++, line, fg, false, width); line = ''; }
        line += char;
      }
      if (rows >= limit) return rows;
      this.text(x, y + rows++, line, fg, false, width);
    }
    return rows;
  }
  lines(color = true) {
    const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';');
    return this.cells.map(row => {
      let style = '', text = '';
      for (const cell of row) {
        const next = `${cell.fg}/${cell.bg}/${cell.bold}`;
        if (color && next !== style) { text += `\x1b[0;${cell.bold ? '1;' : ''}38;2;${rgb(cell.fg)};48;2;${rgb(cell.bg)}m`; style = next; }
        text += cell.text;
      }
      return text + (color ? '\x1b[0m' : '');
    });
  }
}
