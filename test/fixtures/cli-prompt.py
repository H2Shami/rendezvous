# Exercise actual TTY prompts, including hidden input, without a terminal dependency.
import json, os, pty, re, select, signal, subprocess, sys, time
def visible_line(data):
    # Render the cursor/erase operations readline uses, instead of merely finding
    # prompt text that may already have been erased from the terminal screen.
    line, column = [], 0
    for token in re.findall(r'\x1b\[[0-9;?]*[A-Za-z~]|.', data.decode(errors='replace'), re.S):
        if token.startswith('\x1b['):
            op = token[-1]
            amount = token[2:-1]
            count = int(amount) if amount.isdigit() else 1
            if op == 'G': column = max(0, count - 1)
            elif op == 'C': column += count
            elif op == 'D': column = max(0, column - count)
            elif op in ('J', 'K'):
                if amount == '2': line = []
                else: line = line[:column]
        elif token == '\r': column = 0
        elif token == '\n': line, column = [], 0
        elif token >= ' ':
            while len(line) <= column: line.append(' ')
            line[column] = token
            column += 1
    return ''.join(line)

spec = json.load(sys.stdin)
master, slave = pty.openpty()
child = subprocess.Popen(spec['command'], stdin=slave, stdout=subprocess.PIPE, stderr=slave, env=os.environ)
os.close(slave)
transcript = b''
try:
    for step in spec['steps']:
        deadline = time.monotonic() + 8
        while step['wait'].encode() not in transcript:
            if time.monotonic() > deadline:
                raise RuntimeError('Timed out waiting for prompt: ' + step['wait'])
            ready, _, _ = select.select([master], [], [], .1)
            if ready:
                try: chunk = os.read(master, 65536)
                except OSError: chunk = b''
                if not chunk: raise RuntimeError('CLI exited before expected prompt ' + step['wait'] + ': ' + transcript.decode(errors='replace'))
                transcript += chunk
        # Drain the initial redraw before deciding whether a human can see it.
        while select.select([master], [], [], .15)[0]:
            transcript += os.read(master, 65536)
        if not step.get('screen') and step['wait'] not in visible_line(transcript):
            raise RuntimeError('Prompt was erased from the visible terminal: ' + step['wait'])
        # This PTY has no controlling process group. Plain-mode Ctrl+C needs the
        # signal a real terminal would deliver; raw TUI input still uses bytes.
        if step.get('signal') == 'SIGINT': child.send_signal(signal.SIGINT)
        else: os.write(master, step['send'].encode())
    deadline = time.monotonic() + 8
    while child.poll() is None:
        if time.monotonic() > deadline: raise RuntimeError('CLI did not finish')
        ready, _, _ = select.select([master], [], [], .1)
        if ready:
            try: transcript += os.read(master, 65536)
            except OSError: pass
    stdout = child.stdout.read().decode()
    print(json.dumps({'code': child.returncode, 'stdout': stdout, 'transcript': transcript.decode(errors='replace')}))
finally:
    if child.poll() is None: child.kill()
    child.wait()
    os.close(master)
