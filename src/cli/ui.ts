// Match the Rendezvous web accent. Keep pipes/JSON free of ANSI escapes.
export const CRIMSON = '\x1b[38;2;223;7;18m';
export function colorEnabled(stream: { isTTY?: boolean }, env = process.env) {
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  return !!stream.isTTY && env.TERM !== 'dumb';
}
export function crimson(text: string, stream: { isTTY?: boolean } = process.stderr) {
  return colorEnabled(stream) ? `${CRIMSON}${text}\x1b[0m` : text;
}
export function plainTerminal(text: string) {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
export function statusLine(text: string) {
  return text.split('\n').map(line => {
    const match = /^(Room|Agent|Workspace|Owner|Invitation|Private room file|Private state|Resume|Error):/.exec(line);
    return match ? crimson(match[0]) + line.slice(match[0].length) : line;
  }).join('\n');
}

// Compact Bubble-style lettering fits an ordinary 80-column terminal.
export function rendezvousBanner(stream: { isTTY?: boolean } = process.stderr) {
  const letters = [...'RENDEZVOUS'];
  const rows = [
    letters.map(() => '  _  ').join(''),
    letters.map(() => ' / \\ ').join(''),
    letters.map(letter => `( ${letter} )`).join(''),
    letters.map(() => ' \\_/ ').join(''),
  ];
  return crimson(rows.map(row => row.trimEnd()).join('\n'), stream);
}
