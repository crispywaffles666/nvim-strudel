# nvim-strudel Setup Guide for NixOS

This guide covers setting up nvim-strudel on NixOS, which requires special handling for native dependencies.

## Initial Setup

### 1. Install the Plugin

Add to your lazy.nvim config:

```lua
{
  'Goshujinsama/nvim-strudel',
  ft = 'strudel',
  build = function()
    -- Build server
    vim.fn.system('cd ' .. vim.fn.stdpath('data') .. '/lazy/nvim-strudel/server && nix-shell -p gcc gnumake python3 nodejs alsa-lib pkg-config --run "npm install" && npm run build')

    -- Create wrapper script
    local wrapper_path = vim.fn.stdpath('data') .. '/lazy/nvim-strudel/server/strudel-server-wrapper.sh'
    local wrapper_content = [[#!/usr/bin/env bash
# Wrapper script for nvim-strudel server on NixOS
ALSA_LIB=$(find /nix/store -name "libasound.so.2" 2>/dev/null | head -1)
if [ -n "$ALSA_LIB" ]; then
    export LD_LIBRARY_PATH="$(dirname "$ALSA_LIB"):$LD_LIBRARY_PATH"
fi
JACK_LIB=$(find /nix/store -name "libjack.so.0" 2>/dev/null | head -1)
if [ -n "$JACK_LIB" ]; then
    export LD_LIBRARY_PATH="$(dirname "$JACK_LIB"):$LD_LIBRARY_PATH"
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/dist/index.js" "$@"
]]

    local file = io.open(wrapper_path, 'w')
    if file then
      file:write(wrapper_content)
      file:close()
      vim.fn.system('chmod +x ' .. wrapper_path)
    end
  end,
  keys = {
    { '<C-CR>', '<cmd>StrudelEval<cr>', ft = 'strudel', desc = 'Strudel: Eval' },
    { '<leader>ss', '<cmd>StrudelStop<cr>', ft = 'strudel', desc = 'Strudel: Stop' },
  },
  config = function()
    require('strudel').setup({
      server = {
        cmd = {
          vim.fn.stdpath('data') .. '/lazy/nvim-strudel/server/strudel-server-wrapper.sh'
        },
        host = '127.0.0.1',
        port = 37812,
        auto_start = true,
      },
      audio = {
        output = 'webaudio',  -- or 'osc' for SuperCollider/SuperDirt
      },
    })
  end,
}
```

### 2. Create the Wrapper Script (Required!)

**Important:** The build function may not create the wrapper script automatically. Create it manually:

```bash
cd ~/.local/share/nvim/lazy/nvim-strudel/server
cat > strudel-server-wrapper.sh << 'EOF'
#!/usr/bin/env bash
# Wrapper script for nvim-strudel server on NixOS
# Sets up library paths for native dependencies

# Find ALSA library in nix store
ALSA_LIB=$(find /nix/store -name "libasound.so.2" 2>/dev/null | head -1)
if [ -n "$ALSA_LIB" ]; then
    ALSA_DIR=$(dirname "$ALSA_LIB")
    export LD_LIBRARY_PATH="${ALSA_DIR}:$LD_LIBRARY_PATH"
fi

# Find JACK library in nix store (optional, for better audio)
JACK_LIB=$(find /nix/store -name "libjack.so.0" 2>/dev/null | head -1)
if [ -n "$JACK_LIB" ]; then
    JACK_DIR=$(dirname "$JACK_LIB")
    export LD_LIBRARY_PATH="${JACK_DIR}:$LD_LIBRARY_PATH"
fi

# Run the actual server
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/dist/index.js" "$@"
EOF

chmod +x strudel-server-wrapper.sh
```

**Verify it was created:**
```bash
ls -lh ~/.local/share/nvim/lazy/nvim-strudel/server/strudel-server-wrapper.sh
# Should show: -rwxr-xr-x ... strudel-server-wrapper.sh
```

### 3. Build the Server

```bash
cd ~/.local/share/nvim/lazy/nvim-strudel/server
nix-shell -p gcc gnumake python3 nodejs alsa-lib pkg-config --run "npm install"
npm run build
```

## When Updating the Plugin

After running `:Lazy sync` or updating nvim-strudel:

```bash
cd ~/.local/share/nvim/lazy/nvim-strudel/server

# Rebuild the server
nix-shell -p gcc gnumake python3 nodejs alsa-lib pkg-config --run "npm install"
npm run build

# The wrapper script should still exist, but if not, recreate it (see step 2 above)
```

## Quick Start Usage

1. Create a file with `.strudel` extension
2. Write a pattern:
   ```javascript
   s("bd sd bd sd").fast(2)
   ```
3. Press `Ctrl+Enter` to play (or `:StrudelPlay`)
4. Press `<leader>ss` to stop

## Common Commands

| Command | Description |
|---------|-------------|
| `:StrudelPlay` | Start playback |
| `:StrudelStop` | Stop playback |
| `:StrudelPause` | Pause playback |
| `:StrudelHush` | Immediately silence all sounds |
| `:StrudelEval` | Evaluate current buffer/selection |
| `:StrudelStatus` | Show server status |
| `:StrudelPianoroll` | Toggle piano roll visualization |
| `:StrudelSamples` | Browse available samples |

## Troubleshooting

### Server won't start

Check the error with:
```vim
:messages
```

### "libasound.so.2: cannot open shared object file"

The wrapper script isn't working. Verify it exists and is executable:
```bash
ls -la ~/.local/share/nvim/lazy/nvim-strudel/server/strudel-server-wrapper.sh
```

If missing, recreate it (see step 2 above).

### Server exits with code 1

Run the server manually to see the error:
```bash
cd ~/.local/share/nvim/lazy/nvim-strudel/server
./strudel-server-wrapper.sh
```

### No sound output

- Verify PipeWire is running: `pw-cli info 0`
- Check server logs in `:messages`
- Ensure audio device isn't muted

### "Server not found"

The server hasn't been built. Run the build commands (see step 3 above).

### "cmd is not executable" or "invalid value for argument"

The wrapper script is missing or not executable:

```bash
# Check if wrapper exists
ls -lh ~/.local/share/nvim/lazy/nvim-strudel/server/strudel-server-wrapper.sh

# If missing, create it (see step 2 above)
# If exists but not executable:
chmod +x ~/.local/share/nvim/lazy/nvim-strudel/server/strudel-server-wrapper.sh
```

## Using SuperCollider/SuperDirt (Optional)

For better audio quality and lower CPU usage:

1. Install SuperCollider on NixOS:
   ```nix
   environment.systemPackages = with pkgs; [
     supercollider
     pluginsSupercollider.sc3-plugins
   ];
   ```

2. Install SuperDirt (SuperCollider will auto-install this when needed, or manually):
   ```bash
   # Start SuperCollider IDE
   scide

   # In the SuperCollider IDE, run:
   Quarks.install("SuperDirt");
   ```

3. Update your nvim-strudel config:
   ```lua
   require('strudel').setup({
     audio = {
       output = 'osc',
       osc_host = '127.0.0.1',
       osc_port = 57120,
       auto_superdirt = true,
     },
     -- rest of config...
   })
   ```

## Why NixOS Needs Special Setup

NixOS doesn't have system-wide libraries in standard paths. The `midi` and `node-web-audio-api` packages require:

- **Build time**: gcc, make, python3, alsa-lib headers
- **Runtime**: libasound.so.2 (ALSA library)

The wrapper script sets `LD_LIBRARY_PATH` to include the Nix store paths for these libraries.

## Resources

- [nvim-strudel GitHub](https://github.com/Goshujinsama/nvim-strudel)
- [Strudel Documentation](https://strudel.cc/)
- [TidalCycles Tutorial](https://tidalcycles.org/docs/) (similar pattern syntax)

## Notes

- The wrapper script persists across plugin updates (not tracked by git)
- Server build must be re-run after each plugin update
- The `server.cmd` function in config ensures the wrapper is always used
