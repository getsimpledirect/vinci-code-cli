# Vinci Code — providers are open out of the box. No account, no configuration.

Output "vinci/assets/demo-byok.gif"

Set Shell "bash"
Set FontSize 17
Set Width 1180
Set Height 430
Set Padding 26
Set Theme { "name": "vinci", "background": "#14161a", "foreground": "#e8e6e1", "cursor": "#B8C5B0", "selection": "#586B48", "black": "#14161a", "red": "#c96a5b", "green": "#B8C5B0", "yellow": "#d8c78a", "blue": "#8fa9c4", "magenta": "#b294bb", "cyan": "#8fbfbf", "white": "#e8e6e1", "brightBlack": "#5c6169", "brightRed": "#d98878", "brightGreen": "#cbd6c3", "brightYellow": "#e6d9a8", "brightBlue": "#a8bed4", "brightMagenta": "#c7aecd", "brightCyan": "#a8d0d0", "brightWhite": "#f7f7f7" }

Set TypingSpeed 40ms
Hide
Type "clear" Enter
Show
Sleep 700ms

Type "# Fresh checkout. No account, nothing configured."
Sleep 500ms
Enter
Type "vinci --list-models | head -11"
Sleep 300ms
Enter
Sleep 4500ms

Type "# Your provider is already there. Vinci's own classes just sort first."
Sleep 500ms
Enter
Sleep 2500ms

Type "# /login picks a provider. Signing in to Vinci is offered, never required."
Sleep 500ms
Enter
Sleep 3s
