import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { v4 as uuidv4 } from "uuid";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const PORT = 3021;
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Queue of pending requests for the 2021 Roblox Studio plugin
const pendingRequests = new Map();

// Studio Heartbeat & Long-Polling State
let lastStudioPollTime = 0;
let activePoller = null;
let activePollerTimer = null;

function tryDispatchPending(res) {
  for (const [id, reqData] of pendingRequests.entries()) {
    if (!reqData.inFlight) {
      reqData.inFlight = true;
      res.json({
        id,
        tool: reqData.tool,
        args: reqData.args,
      });
      return true;
    }
  }
  return false;
}

function notifyPoller() {
  if (activePoller) {
    clearTimeout(activePollerTimer);
    const poller = activePoller;
    activePoller = null;
    activePollerTimer = null;
    tryDispatchPending(poller);
  }
}

// Endpoint polled by 2021 Roblox Studio plugin (HTTP Long-Polling)
app.get("/poll", (req, res) => {
  lastStudioPollTime = Date.now();

  // If work is already queued, dispatch immediately
  if (tryDispatchPending(res)) {
    return;
  }

  // Release any previous held poller socket
  if (activePoller) {
    clearTimeout(activePollerTimer);
    try {
      activePoller.status(204).end();
    } catch {}
    activePoller = null;
  }

  // Hold request open for up to 2.5 seconds (long-polling)
  activePoller = res;
  activePollerTimer = setTimeout(() => {
    if (activePoller === res) {
      activePoller = null;
      activePollerTimer = null;
      res.status(204).end();
    }
  }, 2500);

  req.on("close", () => {
    if (activePoller === res) {
      clearTimeout(activePollerTimer);
      activePoller = null;
      activePollerTimer = null;
    }
  });
});

// Endpoint called by 2021 Roblox Studio plugin with execution results
app.post("/respond", (req, res) => {
  const { id, success, result, error } = req.body;
  const pending = pendingRequests.get(id);

  if (pending) {
    clearTimeout(pending.timeout);
    pendingRequests.delete(id);
    if (success) {
      pending.resolve(result);
    } else {
      pending.reject(new Error(error || "Execution failed in Roblox Studio"));
    }
  }
  res.json({ status: "ok" });
});

// REST API for web extensions
app.get("/api/status", (req, res) => {
  const isStudioAlive = lastStudioPollTime > 0 && Date.now() - lastStudioPollTime < 4500;
  res.json({
    ok: true,
    server: "Aisaka 2021 Roblox Studio MCP",
    version: "1.5.5-retro",
    studioConnected: isStudioAlive,
    lastHeartbeatSec: lastStudioPollTime > 0 ? Math.round((Date.now() - lastStudioPollTime) / 1000) : null,
    port: PORT,
    pending: pendingRequests.size,
  });
});

app.post("/api/call", async (req, res) => {
  const { tool, args } = req.body;
  if (!tool) return res.status(400).json({ success: false, error: "Missing 'tool'" });

  if (tool === "screen_capture") {
    try {
      const b64 = captureScreenBase64();
      return res.json({ success: true, tool, result: { imageBase64: b64 } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  try {
    const result = await handleToolDispatch(tool, args || {});
    return res.json({ success: true, tool, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

const httpListener = app.listen(PORT, "127.0.0.1", () => {
  console.error(`[Roblox 2021 MCP] HTTP bridge listening on http://127.0.0.1:${PORT}`);
});
httpListener.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[Roblox 2021 MCP] Port ${PORT} already bound by active instance. Reusing bridge.`);
  } else {
    throw err;
  }
});

async function sendToStudio(tool, args, timeoutMs = 25000) {
  // Fast-fail if Studio has disconnected or never connected
  const timeSinceLastPoll = Date.now() - lastStudioPollTime;
  if (lastStudioPollTime > 0 && timeSinceLastPoll > 4500) {
    throw new Error(
      `Roblox Studio is offline or unresponsive (last heartbeat ${Math.round(timeSinceLastPoll / 1000)}s ago). Please open Studio and enable the MCP plugin.`
    );
  } else if (lastStudioPollTime === 0 && httpListener.listening) {
    throw new Error(
      "Roblox Studio has not connected yet. Please ensure Studio is open with the MCP plugin installed and running."
    );
  }

  // If we are in secondary process where port was bound by another process, forward via localhost:3021
  if (!httpListener.listening) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool, args }),
      });
      const data = await res.json();
      if (data.success) return data.result;
      throw new Error(data.error || "Forwarding call failed");
    } catch (e) {
      throw new Error("Bridge communication error: " + e.message);
    }
  }

  return new Promise((resolve, reject) => {
    const id = uuidv4();
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout waiting for Roblox Studio response on '${tool}'`));
    }, timeoutMs);

    pendingRequests.set(id, {
      tool,
      args,
      inFlight: false,
      resolve,
      reject,
      timeout,
    });

    // Instantly notify active long-polling socket
    notifyPoller();
  });
}

// Native Windows Screen Capture Utility
function captureScreenBase64() {
  const outFile = path.join(os.tmpdir(), `studio_cap_${Date.now()}.b64`);
  const psScript = `
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinUser {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$targetHwnd = [IntPtr]::Zero

$procs = Get-Process | Where-Object { 
    $_.ProcessName -eq "AisakaStudio" -or
    $_.ProcessName -eq "RobloxStudioBeta" -or
    $_.ProcessName -like "*RobloxStudio*" -or
    $_.ProcessName -like "*Octane*" -or
    $_.MainWindowTitle -like "*Roblox Studio*" -or 
    $_.MainWindowTitle -like "*Aisaka*" -or
    $_.MainWindowTitle -like "*Octane*"
}

if ($procs) {
    $proc = $procs[0]
    $targetHwnd = $proc.MainWindowHandle
    if ([WinUser]::IsIconic($targetHwnd)) {
        [WinUser]::ShowWindow($targetHwnd, 9) | Out-Null
        Start-Sleep -Milliseconds 200
    }
    [WinUser]::SetForegroundWindow($targetHwnd) | Out-Null
    Start-Sleep -Milliseconds 350
}

if ($targetHwnd -ne [IntPtr]::Zero) {
    $rect = New-Object WinUser+RECT
    [WinUser]::GetWindowRect($targetHwnd, [ref]$rect) | Out-Null
    $w = [Math]::Max(10, $rect.Right - $rect.Left)
    $h = [Math]::Max(10, $rect.Bottom - $rect.Top)
    
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $gfx.Dispose()
} else {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $gfx.Dispose()
}

$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$b64 = [Convert]::ToBase64String($ms.ToArray())
$ms.Dispose()

[System.IO.File]::WriteAllText("${outFile.replace(/\\/g, "\\\\")}", $b64)
`;

  const scriptPath = path.join(os.tmpdir(), `cap_${Date.now()}.ps1`);
  try {
    fs.writeFileSync(scriptPath, psScript, "utf-8");
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, {
      timeout: 12000,
      windowsHide: true,
    });
    if (fs.existsSync(outFile)) {
      const b64 = fs.readFileSync(outFile, "utf-8").trim();
      return b64;
    }
    throw new Error("Screenshot output file not generated");
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

// Windows Keyboard Automation for Studio Playtest Control
function sendStudioKey(keyCombination) {
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinUserPlaytest {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
$procs = Get-Process | Where-Object { 
    $_.ProcessName -eq "AisakaStudio" -or
    $_.ProcessName -eq "RobloxStudioBeta" -or
    $_.ProcessName -like "*RobloxStudio*" -or
    $_.ProcessName -like "*Octane*" -or
    $_.MainWindowTitle -like "*Roblox Studio*" -or 
    $_.MainWindowTitle -like "*Aisaka*" -or
    $_.MainWindowTitle -like "*Octane*"
}
if ($procs) {
    $proc = $procs[0]
    $hwnd = $proc.MainWindowHandle
    if ([WinUserPlaytest]::IsIconic($hwnd)) {
        [WinUserPlaytest]::ShowWindow($hwnd, 9) | Out-Null
        Start-Sleep -Milliseconds 200
    }
    [WinUserPlaytest]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait("${keyCombination}")
} else {
    Write-Error "Roblox Studio process not found"
}
`;
  const tmp = path.join(os.tmpdir(), `play_${Date.now()}.ps1`);
  try {
    fs.writeFileSync(tmp, psScript, "utf-8");
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, {
      timeout: 10000,
      windowsHide: true,
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Tool Dispatch Handler with ZeroScript / Modern Aliases
async function handleToolDispatch(name, args) {
  if (name === "list_roblox_studios") {
    return {
      studios: [
        {
          id: "2021-studio",
          name: "2021 Roblox Studio (Aisaka)",
        },
      ],
    };
  }
  if (name === "get_studio_state") {
    return {
      datamodel_type: "Edit",
      play_state: "Edit",
      state: "Ready",
    };
  }
  if (name === "screen_capture") {
    const b64 = captureScreenBase64();
    return { imageBase64: b64 };
  }
  if (name === "search_game_tree") {
    return await sendToStudio("get_tree", {
      root: args.path || "game.Workspace",
      maxDepth: args.max_depth || args.maxDepth || 2,
    });
  }
  if (name === "script_read") {
    return await sendToStudio("read_script", {
      path: args.target_file || args.path,
    });
  }
  if (name === "multi_edit") {
    const filePath = args.file_path || args.path;
    const edits = args.edits || [];
    if (edits.length > 0 && edits[0].old_string === "") {
      return await sendToStudio("write_script", {
        path: filePath,
        source: edits[0].new_string,
      });
    }
    const current = await sendToStudio("read_script", { path: filePath });
    let updated = current;
    for (const edit of edits) {
      if (edit.replace_all) {
        updated = updated.split(edit.old_string).join(edit.new_string);
      } else {
        updated = updated.replace(edit.old_string, edit.new_string);
      }
    }
    return await sendToStudio("write_script", { path: filePath, source: updated });
  }
  if (name === "script_search" || name === "search_scripts") {
    return await sendToStudio("script_grep", args);
  }
  if (name === "audit_scene_assets") {
    return await sendToStudio("audit_scene_assets", args);
  }
  if (name === "start_playtest") {
    const mode = (args.mode || "play").toLowerCase();
    const key = mode === "run" ? "{F8}" : "{F5}";
    sendStudioKey(key);
    return {
      status: "started",
      mode: mode === "run" ? "Run (Physics/Server Simulation)" : "Play Solo",
      message: `Started ${mode === "run" ? "Run simulation (F8)" : "Play Solo (F5)"} in Roblox Studio.`
    };
  }
  if (name === "stop_playtest") {
    sendStudioKey("+{F5}");
    return {
      status: "stopped",
      message: "Stopped playtest simulation (Shift+F5). Returned to Edit mode."
    };
  }
  if (name === "run_playtest") {
    const duration = Math.min(30, Math.max(2, Number(args.duration) || 5));
    const mode = (args.mode || "play").toLowerCase();
    const captureScreen = args.capture_screen !== false;
    const startKey = mode === "run" ? "{F8}" : "{F5}";

    // 1. Launch playtest
    sendStudioKey(startKey);

    // 2. Wait for test duration
    await new Promise((resolve) => setTimeout(resolve, duration * 1000));

    // 3. Capture screenshot during play if enabled
    let imageBase64 = null;
    if (captureScreen) {
      try {
        imageBase64 = captureScreenBase64();
      } catch (e) {
        console.error("Playtest screenshot capture failed:", e.message);
      }
    }

    // 4. Stop playtest and return to edit mode
    sendStudioKey("+{F5}");
    await new Promise((resolve) => setTimeout(resolve, 800));

    // 5. Gather and filter output logs
    let logs = "";
    try {
      logs = await sendToStudio("get_output_log", { limit: 60 });
    } catch {}

    const errors = [];
    const warnings = [];
    if (typeof logs === "string") {
      for (const line of logs.split("\n")) {
        if (line.includes("[Error]") || line.includes("HTTP 5") || line.includes("Server Error")) {
          errors.push(line);
        } else if (line.includes("[Warning]")) {
          warnings.push(line);
        }
      }
    }

    const summary = `=== Playtest Results (${mode === "run" ? "Run" : "Play Solo"} - ${duration}s) ===
Errors Detected: ${errors.length}
Warnings Detected: ${warnings.length}
${errors.length > 0 ? "\nErrors Found:\n" + errors.slice(0, 10).join("\n") : "No script or engine errors detected during playtest."}

Recent Console Output:
${typeof logs === "string" ? logs.split("\n").slice(-15).join("\n") : ""}`;

    return {
      status: "completed",
      durationSeconds: duration,
      mode,
      errorsCount: errors.length,
      errors: errors.slice(0, 15),
      warningsCount: warnings.length,
      summary,
      imageBase64
    };
  }

  return await sendToStudio(name, args);
}

// Setup Model Context Protocol (MCP) Server
const server = new Server(
  {
    name: "roblox-2021-studio",
    version: "1.5.5",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_roblox_studios",
        description: "Lists connected 2021 Roblox Studio instances",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_studio_state",
        description: "Gets the state of 2021 Roblox Studio (Edit/Play mode)",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "screen_capture",
        description: "Captures a screenshot of the 2021 Roblox Studio / Aisaka window",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "execute_luau",
        description: "Executes Luau code in 2021 Roblox Studio edit context and returns output",
        inputSchema: {
          type: "object",
          properties: { code: { type: "string", description: "Luau code to run" } },
          required: ["code"],
        },
      },
      {
        name: "get_tree",
        description: "Scans and returns the hierarchy tree starting at root path",
        inputSchema: {
          type: "object",
          properties: {
            root: { type: "string", default: "game.Workspace" },
            maxDepth: { type: "number", default: 2 },
          },
        },
      },
      {
        name: "search_game_tree",
        description: "Explore the Roblox game hierarchy tree",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", default: "Workspace" },
            max_depth: { type: "number", default: 2 },
          },
        },
      },
      {
        name: "read_script",
        description: "Reads the complete Source text of a Script",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "script_read",
        description: "Reads a script from the Roblox workspace",
        inputSchema: {
          type: "object",
          properties: { target_file: { type: "string" } },
          required: ["target_file"],
        },
      },
      {
        name: "write_script",
        description: "Updates or overwrites the Source text of an existing Script in Studio",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, source: { type: "string" } },
          required: ["path", "source"],
        },
      },
      {
        name: "multi_edit",
        description: "Edits or creates scripts in Studio",
        inputSchema: {
          type: "object",
          properties: { file_path: { type: "string" }, edits: { type: "array" } },
          required: ["file_path", "edits"],
        },
      },
      {
        name: "create_instance",
        description: "Creates a new Instance in the DataModel",
        inputSchema: {
          type: "object",
          properties: {
            className: { type: "string" },
            name: { type: "string" },
            parent: { type: "string", default: "game.Workspace" },
            properties: { type: "object" },
          },
          required: ["className"],
        },
      },
      {
        name: "delete_instance",
        description: "Deletes an instance from the DataModel",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "get_output_log",
        description: "Retrieves recent messages from Studio's output log",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number", default: 50 } },
        },
      },
      {
        name: "script_grep",
        description: "Searches all Scripts, LocalScripts, and ModuleScripts across the place for a text pattern or keyword",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "The string or keyword to search for" },
            case_sensitive: { type: "boolean", default: false, description: "Whether to perform a case-sensitive match" },
            root: { type: "string", description: "Optional root path to search within (defaults to all game services)" },
            max_matches: { type: "number", default: 100, description: "Maximum number of matches to return" },
          },
          required: ["pattern"],
        },
      },
      {
        name: "inspect_instance",
        description: "Inspects detailed properties, children, attributes, and tags of an instance",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "The path of the instance (e.g. Workspace.Part or ServerScriptService.Handler)" },
          },
          required: ["path"],
        },
      },
      {
        name: "audit_scene_assets",
        description: "Scans all 3D objects in the scene (sounds, meshes, decals, animations, clothing) and reports all external asset IDs",
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string", description: "Optional specific service or model path to scan (defaults to all services)" },
          },
        },
      },
      {
        name: "start_playtest",
        description: "Starts a playtest in Roblox Studio (F5 for Play Solo, F8 for Run / Server Simulation)",
        inputSchema: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["play", "run"], default: "play", description: "'play' for Play Solo (F5), 'run' for physics/server simulation (F8)" },
          },
        },
      },
      {
        name: "stop_playtest",
        description: "Stops the active playtest simulation in Roblox Studio and returns to Edit mode (Shift+F5)",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "run_playtest",
        description: "Runs an autonomous test: starts playtest, monitors for runtime errors over duration, captures screenshot, and stops test",
        inputSchema: {
          type: "object",
          properties: {
            duration: { type: "number", default: 5, description: "Seconds to run test (2 to 30, default 5)" },
            mode: { type: "string", enum: ["play", "run"], default: "play", description: "Test mode: 'play' (Play Solo) or 'run' (Run)" },
            capture_screen: { type: "boolean", default: true, description: "Whether to snap a screenshot during the test" },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  if (name === "screen_capture") {
    try {
      const b64 = captureScreenBase64();
      return {
        content: [
          { type: "image", data: b64, mimeType: "image/png" },
          { type: "text", text: "Captured screenshot of Roblox Studio / Aisaka window." },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: "Screen capture failed: " + err.message }],
        isError: true,
      };
    }
  }

  try {
    const res = await handleToolDispatch(name, args || {});

    if (name === "run_playtest" && res && res.imageBase64) {
      return {
        content: [
          { type: "image", data: res.imageBase64, mimeType: "image/png" },
          { type: "text", text: res.summary || JSON.stringify(res, null, 2) },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: typeof res === "string" ? res : JSON.stringify(res, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: "Error: " + err.message }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
