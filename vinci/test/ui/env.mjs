process.env.PI_OFFLINE = "1";
process.env.VINCI_CODE = "1";
process.env.VINCI_ASCII_WORDMARK = "1";
// This suite measures its xterm virtual terminal, not the non-TTY orchestration shell.
process.env.TERM = "xterm-256color";
delete process.env.NO_COLOR;
delete process.env.VINCI_PLAIN;
delete process.env.VINCI_SCREEN_READER;
delete process.env.VINCI_REDUCED_MOTION;
process.env.VINCI_NO_VERIFY = "1";
process.env.VINCI_NO_SANDBOX = "1";
