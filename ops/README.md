# macOS service templates

`npm run scalper:install` is the preferred installer for the main service. It
generates a private LaunchAgent with the current Node executable, repository
path, and log directory; it does not load the agent unless
`SCALPER_INSTALL_ACK=1` is set and `--load` is passed.

The other plist files are portable templates. Replace `__NODE_PATH__` and
`__REPOSITORY_PATH__` in a copy outside the repository before installing it in
`~/Library/LaunchAgents`. Do not commit the rendered machine-local copy. Start
new services in paper mode with the kill switch active and inspect their logs
under `data/scalper/`.
