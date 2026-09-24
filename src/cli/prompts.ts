import { createInterface } from "node:readline/promises";
import { crimson } from './ui.js';
import { Writable } from "node:stream";
import { askTui, tuiChild } from './tui-channel.js';

export class UsageError extends Error {}
export class Prompts {
  constructor(
    private signal: AbortSignal,
    private enabled = true,
  ) {}
  get interactive() {
    return this.enabled && (tuiChild || (!!process.stdin.isTTY && !!process.stderr.isTTY));
  }
  async ask(
    label: string,
    hint: string,
    options: { secret?: boolean; defaultValue?: string } = {},
  ) {
    if (!this.interactive)
      throw new UsageError(`${label} is required. ${hint}`);
    if (tuiChild) return askTui(label, hint, this.signal, options);
    // Suppress readline's echo for invitation URLs and tokens; prompts still go to stderr.
    let muted = false;
    const output = new Writable({
      write(chunk, _encoding, done) {
        if (!muted) process.stderr.write(chunk);
        done();
      },
    });
    const rl = createInterface({
      input: process.stdin,
      output,
      terminal: true,
    });
    const local = new AbortController();
    const cancel = () => {
      local.abort();
    };
    const signal = AbortSignal.any([this.signal, local.signal]);
    rl.on("SIGINT", cancel);
    rl.on("close", cancel);
    try {
      // Readline must own the prompt: an empty question erases text printed
      // separately when it redraws the terminal line.
      const pending = rl.question(
        `${crimson(label)}${options.defaultValue ? ` [${options.defaultValue}]` : ""}: `,
        { signal },
      );
      // The initial prompt is visible; subsequent secret-input redraws are hidden.
      muted = !!options.secret;
      const answer =
        (await pending).trim() ||
        options.defaultValue ||
        "";
      if (!answer) throw new UsageError(`${label} cannot be empty. ${hint}`);
      return answer;
    } finally {
      rl.close();
      if (options.secret) process.stderr.write("\n");
    }
  }
}
