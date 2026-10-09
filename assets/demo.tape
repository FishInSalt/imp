# Ink demo — install, launch, hand it a task, exit.
#
# Setup:   bash assets/demo-setup.sh   (creates /tmp/ink-demo)
# Record:  vhs assets/demo.tape        (requires vhs: brew install vhs)
# Output:  assets/demo.gif   (referenced from README.md at the repository
#          raw URL — keep the path in sync with the READMEs)
Output "assets/demo.gif"

Set Shell "zsh"
Set FontFamily "Menlo"
Set FontSize 15
Set Width 1000
Set Height 620
Set Padding 14
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set Framerate 20
Set CursorBlink true

# Start the recording inside the prepared sandbox with a clean screen.
Hide
Type "cd /tmp/ink-demo && clear"
Enter
Sleep 600ms
Show

Sleep 900ms
Type "npm install -g ink-agent@latest"
Sleep 400ms
Enter
Sleep 8s
Type "ink"
Sleep 400ms
Enter
Sleep 6s
Type "what does this project do? answer in two short lines"
Sleep 400ms
Enter
Sleep 25s
Ctrl+D
Sleep 3s
