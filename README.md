# Neojumper

A local API that opens a file at a line in the earliest-created running
Neovim instance, closes the other windows in the current tab, selects its tmux
or HerdR pane, and brings Ghostty forward. tmux is preferred; HerdR is used as
a fallback when no matching tmux pane is available.

Relative file paths are resolved from that Neovim instance's current working
directory. Absolute paths and `~/...` paths are also supported.

Used for userscript to open pullrequests directly in editor

## Run manually

```bash
cd ~/dev/neojumper
npm start
```

Send a request:

```bash
curl \
  --header 'Content-Type: application/json' \
  --data '{"file":"src/server.js","line":42}' \
  http://localhost:8766/api/open
```

## Start automatically at login

```bash
cd ~/dev/neojumper
./manage-launchd.sh load
```

Other supported actions:

```bash
./manage-launchd.sh restart
./manage-launchd.sh unload
```

Logs are written to `logs/neojumper.log` and `logs/neojumper.err.log`. Each
request logs its total duration and a per-stage timing breakdown (`discover`,
`nvimEdit`, `findPane`, `focus`), which is also returned in the JSON response as
`timings` and `totalMs`.

## Assumptions

- Node.js and Neovim are available on `PATH`.
- tmux and/or HerdR are available on `PATH` when their multiplexer support is
  needed. tmux is preferred, with HerdR as the fallback.
- Neovim is running inside an attached tmux or HerdR session in Ghostty.
- Ghostty is installed, since Neojumper uses it to bring the terminal forward.

The server only listens on `127.0.0.1`. `POST /api/open` accepts JSON requests
from localhost.
