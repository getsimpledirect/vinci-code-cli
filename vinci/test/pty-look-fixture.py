"""Capture the real launcher from a fixed-size PTY through startup and /quit."""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

launcher, presentation, *args = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    os.execvp("bash", ["bash", launcher, *args])

raw = bytearray()
stage = 0
waiting_for_resume = presentation == "plain" and "--resume" in args
waiting_for_migration = presentation == "plain-migration"
deadline = time.monotonic() + 20
try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.2)
        if waiting_for_resume and not termios.tcgetattr(master)[3] & termios.ICANON:
            raise RuntimeError("Plain --resume started a raw terminal driver")
        if waiting_for_migration and b"Press any key to continue..." in raw:
            if not termios.tcgetattr(master)[3] & termios.ICANON:
                os.write(master, b"x")
                waiting_for_migration = False
        if not readable:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not chunk:
            break
        raw.extend(chunk)
        if waiting_for_resume and b"Choice (Enter cancels): " in raw:
            os.write(master, b"1\r")
            waiting_for_resume = False
        if stage == 0 and b"Ready" in raw:
            if presentation == "plain-migration":
                if waiting_for_migration:
                    raise RuntimeError("Plain migration startup skipped the raw-key acknowledgement")
                if not termios.tcgetattr(master)[3] & termios.ICANON:
                    raise RuntimeError("Plain migration acknowledgement did not restore canonical input")
            os.write(master, b"Check the colour-only pulse\r" if presentation == "rich-motion" else b"/help\r")
            stage = 1
        if stage != 1:
            continue
        after_ready = raw[raw.find(b"Ready"):]
        if presentation == "rich-motion":
            can_quit = b"NON-TTY-ANSWER-OK" in after_ready
        else:
            can_quit = b"/model" in after_ready or b"/quit" in after_ready
        if can_quit:
            os.write(master, b"/quit\r")
            stage = 2
    else:
        raise TimeoutError("Vinci did not finish PTY startup and /quit")
finally:
    if stage != 2:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    os.close(master)
    sys.stdout.buffer.write(raw)

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if stage == 2 else 1)
