# Vinci Code — a real coding turn in the interactive TUI, on the user's own key.
# OPENROUTER_API_KEY is set in the ENVIRONMENT before vhs runs, never typed,
# so it cannot appear in a frame.

Output "vinci/assets/demo-coding.gif"

Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 20
Set Theme { "name": "vinci", "background": "#14161a", "foreground": "#e8e6e1", "cursor": "#B8C5B0", "selection": "#586B48", "black": "#14161a", "red": "#c96a5b", "green": "#B8C5B0", "yellow": "#d8c78a", "blue": "#8fa9c4", "magenta": "#b294bb", "cyan": "#8fbfbf", "white": "#e8e6e1", "brightBlack": "#5c6169", "brightRed": "#d98878", "brightGreen": "#cbd6c3", "brightYellow": "#e6d9a8", "brightBlue": "#a8bed4", "brightMagenta": "#c7aecd", "brightCyan": "#a8d0d0", "brightWhite": "#f7f7f7" }

Set TypingSpeed 30ms
Hide
Type "clear" Enter
Show
Sleep 500ms

Type "vinci"
Sleep 300ms
Enter
Sleep 5s

Type "sizes.py lists the SMALLEST files but should list the largest. Fix it, then run python3 sizes.py . to prove it works."
Sleep 800ms
Enter
Sleep 45s
