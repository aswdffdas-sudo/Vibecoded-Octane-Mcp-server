# 2021 Roblox Studio MCP Bridge 🎮🤖

Connect AI coding assistants (**OpenCode**, **Claude Desktop / Claude Code**, **Cursor**, **Codex**, **Windsurf**, **Gemini CLI**, and browser AIs via **ZeroScript**) directly to **2021 Roblox Studio (Octane / Aisaka)** using Anthropic's **Model Context Protocol (MCP)**.

---

## 🌟 Features

- **`screen_capture`**: Captures high-res screenshots of your Studio viewport/GUI directly into the AI chat.
- **`execute_luau`**: Executes arbitrary Luau code in Studio edit mode with automatic `ChangeHistoryService` undo checkpoints.
- **`read_script` & `write_script`**: Reads and overwrites the full source code of scripts, local scripts, and module scripts.
- **`script_grep`**: Global regex search across all scripts in the place.
- **`inspect_instance`**: Deep property inspector (CFrames, colors, attributes, tags, children).
- **`audit_scene_assets`**: Scans all 3D scene objects (sounds, meshes, decals, particles, clothing) for asset IDs.
- **Playtest Suite (`run_playtest`, `start_playtest`, `stop_playtest`)**: Autonomous AI playtesting with gameplay screenshots and console error diagnostics.
- **Stability Suite**: HTTP Long-Polling (94% less traffic), Studio heartbeat tracking, infinite-loop guard, and UTF-8 sanitization.

---

## 🚀 Quick Setup Guide

### 1. Install the Studio Plugin
1. Open Windows Run (`Win + R`), type:
   ```text
   %localappdata%\Roblox\Plugins
   ```
   and press **Enter**.
2. Copy **`MCPBridge2021.lua`** into that folder.
3. Open **2021 Roblox Studio** (Octane).
4. Check your Output window in Studio; you should see:
   ```text
   [MCP 2021] Bridge initialized. Connecting to http://127.0.0.1:3021 ...
   ```
   *(Note: The plugin automatically enables `HttpService` on launch).*

---

### 2. Install Dependencies
Open your terminal (PowerShell or Command Prompt) in the repository folder and run:

```bash
npm install
```

---

## 🔌 Connect to Your AI Client

### Option 1: OpenCode
Add this to `opencode.json` (or `~/.config/opencode/opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "Roblox_2021": {
      "type": "local",
      "command": ["node", "C:/path/to/server.js"],
      "enabled": true
    }
  }
}
```

---

### Option 2: Claude Desktop
Add this to `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "roblox-2021": {
      "command": "node",
      "args": ["C:/path/to/server.js"]
    }
  }
}
```

---

### Option 3: Cursor
In your project folder, create `.cursor/mcp.json` (or add in Cursor **Settings > Features > MCP**):

```json
{
  "mcpServers": {
    "roblox-2021": {
      "command": "node",
      "args": ["C:/path/to/server.js"]
    }
  }
}
```

---

### Option 4: Codex CLI
Run in your terminal:

```bash
codex mcp add roblox-2021 -- node "C:/path/to/server.js"
```

---

### Option 5: Windsurf
Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "roblox-2021": {
      "command": "node",
      "args": ["C:/path/to/server.js"]
    }
  }
}
```

---

### Option 6: Claude Code CLI
Run in your terminal:

```bash
claude mcp add roblox-2021 -- node "C:/path/to/server.js"
```

---

## 🛠 Available Tools for the AI

| Tool | Description |
| :--- | :--- |
| `screen_capture` | Captures a high-resolution screenshot of the Studio window or active screen for visual AI inspection. |
| `execute_luau` | Executes arbitrary Luau code in Studio's edit context with undo waypoint tracking. |
| `get_tree` | Traverses and returns the DataModel hierarchy (`game.Workspace`, `game.StarterGui`, etc.). |
| `read_script` | Reads the complete `.Source` text of any Script, LocalScript, or ModuleScript. |
| `write_script` | Writes or overwrites the `.Source` of any script with automatic undo checkpoints. |
| `create_instance` | Creates new instances (`Part`, `Model`, `ScreenGui`, etc.) with initial properties. |
| `delete_instance` | Destroys instances in the DataModel safely. |
| `get_output_log` | Retrieves recent output log messages from Studio. |
| `script_grep` | Global search across all scripts in the place for matching text/regex lines. |
| `inspect_instance` | Inspects detailed properties, children, attributes, and tags of any instance. |
| `audit_scene_assets` | Scans all 3D scene objects (sounds, meshes, decals, particles, clothing) and reports external asset IDs. |
| `start_playtest` | Starts a playtest in Studio (`mode`: `"play"` [F5] or `"run"` [F8]). |
| `stop_playtest` | Stops the active playtest simulation and returns to Edit mode (Shift+F5). |
| `run_playtest` | Autonomous AI test: launches test, monitors for console errors over N seconds, takes gameplay screenshot, and returns to Edit mode. |

---

## 📄 License
MIT License
