Output assets/demo-recall.gif
Require node

Set FontFamily "JetBrains Mono"
Set FontSize 13
Set Width 1120
Set Height 640
Set Padding 28
Set Theme Dracula

# Show the ZTMR primitive: agent gets a constant-size receipt, the dashboard
# side-channel gets the full recall, and a context-budget comparison prints.

Type "node dist/index.js --demo"
Sleep 250ms
Enter
Sleep 4s

# Briefly surface the usage panel.
Sleep 200ms
Type "node dist/index.js --help"
Sleep 200ms
Enter
Sleep 2s
