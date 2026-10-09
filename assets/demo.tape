# Ink demo — install, launch, hand it a task, exit.
#
# Setup:   bash assets/demo-setup.sh   (creates /tmp/ink-demo)
# Record:  vhs assets/demo.tape        (requires vhs >= 0.12.1:
#          brew install vhs — v0.12.0 silently produces no output file)
# Output:  assets/demo.gif   (referenced from README.md at the repository
#          raw URL — keep the path in sync with the READMEs)
Output "assets/demo.gif"

Set Shell zsh
Set FontFamily "Menlo"
Set FontSize 15
Set Width 1000
Set Height 620
Set Padding 14
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set Framerate 20
Set CursorBlink true

# Start the recording inside the prepared sandbox with a clean prompt.
Hide
Type "cd /tmp/ink-demo && clear && export PROMPT='%1~ $ '"
Enter
Sleep 600ms
Show

Sleep 900ms
Type "npm install -g ink-agent@latest"
Sleep 300ms
Enter
Wait+Screen@90s /(up to date|changed|audited)/
Sleep 1500ms
Type "ink"
Sleep 300ms
Enter
Wait+Screen@30s /Tips for getting started/
Sleep 2500ms
Type "what does this project do? two short lines"
Sleep 300ms
Enter
# Fixed window: the answer to this tiny task lands in 2-4s (deepseek-flash),
# and a Wait+Screen here proved unreliable under ttyd while the TUI streams
# (the screen read froze at the submit moment — vhs 0.12.1, 2026-10-09).
# The published gif is trimmed at ~20s (≈3.8s after the answer completes).
Sleep 12s
Ctrl+D
Sleep 2500ms
