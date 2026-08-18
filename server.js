const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { performance } = require("perf_hooks");

const execFileAsync = promisify(execFile);

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8766);
const NVIM_BIN = process.env.NVIM_BIN || "/opt/homebrew/bin/nvim";
const TMUX_BIN = process.env.TMUX_BIN || "/opt/homebrew/bin/tmux";
const PS_BIN = "/bin/ps";
const OPEN_BIN = "/usr/bin/open";

// launchd starts processes without a locale, which makes tmux sanitize the
// tab separators in "-F" output to underscores and breaks field parsing.
// Force a UTF-8 locale so child processes behave like an interactive shell.
const CHILD_ENV = {
  ...process.env,
  LANG: process.env.LANG || "en_US.UTF-8",
  LC_ALL: process.env.LC_ALL || process.env.LANG || "en_US.UTF-8",
};

function run(binary, args, extraOptions) {
  return execFileAsync(binary, args, { env: CHILD_ENV, ...extraOptions });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function timed(timings, label, task) {
  const start = performance.now();
  try {
    return await task();
  } finally {
    timings[label] = Math.round(performance.now() - start);
  }
}

function vimString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function getRuntimeRoot() {
  if (process.env.XDG_RUNTIME_DIR) {
    return process.env.XDG_RUNTIME_DIR;
  }

  const temporaryDirectory = process.env.TMPDIR || os.tmpdir();
  return path.join(temporaryDirectory, `nvim.${process.env.USER}`);
}

async function findNeovimSockets() {
  const runtimeRoot = getRuntimeRoot();
  const socketCandidates = [];
  let runtimeDirectories;

  try {
    runtimeDirectories = await fs.promises.readdir(runtimeRoot, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  for (const runtimeDirectory of runtimeDirectories) {
    if (!runtimeDirectory.isDirectory()) {
      continue;
    }

    const directoryPath = path.join(runtimeRoot, runtimeDirectory.name);
    const entries = await fs.promises.readdir(directoryPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const nameMatch = entry.name.match(/^nvim\.(\d+)\.0$/);
      if (!nameMatch) {
        continue;
      }

      const socketPath = path.join(directoryPath, entry.name);
      const stats = await fs.promises.stat(socketPath);
      if (!stats.isSocket()) {
        continue;
      }

      socketCandidates.push({
        path: socketPath,
        processId: Number(nameMatch[1]),
        createdAt: stats.birthtimeMs || stats.ctimeMs,
      });
    }
  }

  return socketCandidates.sort((left, right) => {
    return left.createdAt - right.createdAt;
  });
}

// The auto-generated socket is named "nvim.<PID>.0", so the owning process id
// can be read straight from the file name. A cheap signal check confirms the
// process is still alive without spawning lsof or Neovim.
function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function findLiveNeovim() {
  const sockets = await findNeovimSockets();

  for (const socket of sockets) {
    if (isProcessAlive(socket.processId)) {
      return {
        socketPath: socket.path,
        neovimProcessIds: [socket.processId],
      };
    }
  }

  throw new Error("No running Neovim socket was found.");
}

async function getParentProcessIds() {
  const { stdout } = await run(PS_BIN, ["-axo", "pid=,ppid="]);
  const parents = new Map();

  for (const line of stdout.trim().split("\n")) {
    const [processId, parentProcessId] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(processId) && Number.isInteger(parentProcessId)) {
      parents.set(processId, parentProcessId);
    }
  }

  return parents;
}

function getAncestors(processId, parents) {
  const ancestors = new Set([processId]);
  let currentProcessId = processId;

  while (parents.has(currentProcessId)) {
    const parentProcessId = parents.get(currentProcessId);
    if (ancestors.has(parentProcessId) || parentProcessId <= 1) {
      break;
    }

    ancestors.add(parentProcessId);
    currentProcessId = parentProcessId;
  }

  return ancestors;
}

async function findTmuxPane(neovimProcessIds) {
  const [parents, panesResult] = await Promise.all([
    getParentProcessIds(),
    run(TMUX_BIN, [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{pane_pid}\t#{session_name}\t#{window_index}",
    ]),
  ]);
  const ancestorSets = neovimProcessIds.map((processId) => {
    return getAncestors(processId, parents);
  });

  for (const line of panesResult.stdout.trim().split("\n")) {
    const [paneId, paneProcessIdValue, sessionName, windowIndex] =
      line.split("\t");
    const paneProcessId = Number(paneProcessIdValue);
    const containsNeovim = ancestorSets.some((ancestors) => {
      return ancestors.has(paneProcessId);
    });

    if (containsNeovim) {
      return { paneId, sessionName, windowIndex };
    }
  }

  throw new Error("The selected Neovim process is not running inside tmux.");
}

// Resolve, validate, open and position the cursor in a single Neovim call.
// The path is resolved by Neovim relative to its own working directory, so
// relative paths behave the same as if typed inside the running session.
// `only` is best-effort: a floating window makes it throw E5601 after the
// file is already open, which used to turn a successful jump into HTTP 500.
async function editInNeovim(socketPath, file, line) {
  const luaCode =
    "(function() local f=vim.fn.expand(_A.file) local abs=vim.fn.fnamemodify(f,':p') " +
    "if vim.fn.filereadable(f)==0 then return vim.fn.json_encode({ok=false,path=abs}) end " +
    "vim.cmd('edit '..vim.fn.fnameescape(f)) if #vim.api.nvim_list_wins() > 1 then pcall(vim.cmd,'only') end vim.fn.cursor(_A.line,1) " +
    "return vim.fn.json_encode({ok=true,path=abs}) end)()";
  const expression =
    `luaeval(${vimString(luaCode)}, {'file': ${vimString(file)}, 'line': ${line}})`;

  const { stdout } = await run(
    NVIM_BIN,
    ["--server", socketPath, "--remote-expr", expression],
    { timeout: 3000 },
  );

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Unexpected response from Neovim.");
  }

  if (!parsed.ok) {
    throw new Error(`File does not exist: ${parsed.path}`);
  }

  return parsed;
}

// select-pane alone does not change the active window, so both are required.
// tmux runs them (plus the client switch) as a single process: passing ";" as
// its own argument tells tmux to treat what follows as a separate command.
async function focusTmuxPane(pane) {
  const paneTarget = `${pane.sessionName}:${pane.windowIndex}.${pane.paneId}`;
  await Promise.all([
    run(TMUX_BIN, [
      "switch-client", "-t", pane.sessionName,
      ";", "select-window", "-t", paneTarget,
      ";", "select-pane", "-t", paneTarget,
    ]),
    run(OPEN_BIN, ["-a", "Ghostty"]),
  ]);
}

async function openFile(file, line, timings) {
  const { socketPath, neovimProcessIds } = await timed(timings, "discover", () => {
    return findLiveNeovim();
  });

  // The edit does not depend on the tmux pane, and focusing only needs the
  // pane, so run both flows concurrently.
  const focusFlow = (async () => {
    const pane = await timed(timings, "findPane", () => {
      return findTmuxPane(neovimProcessIds);
    });
    await timed(timings, "focus", () => focusTmuxPane(pane));
    return pane;
  })();

  const [edit, pane] = await Promise.all([
    timed(timings, "nvimEdit", () => editInNeovim(socketPath, file, line)),
    focusFlow,
  ]);

  return {
    file: edit.path,
    line,
    socket: socketPath,
    tmux: `${pane.sessionName}:${pane.windowIndex}.${pane.paneId}`,
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 16 * 1024) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function isAllowedRequest(request) {
  const allowedHosts = new Set([
    `localhost:${PORT}`,
    `127.0.0.1:${PORT}`,
  ]);
  if (!allowedHosts.has(request.headers.host)) {
    return false;
  }

  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }

  return (
    origin === `http://localhost:${PORT}` ||
    origin === `http://127.0.0.1:${PORT}`
  );
}

async function handleOpenRequest(request, response) {
  if (!isAllowedRequest(request)) {
    writeJson(response, 403, { error: "Request origin is not allowed." });
    return;
  }

  if (request.headers["content-type"] !== "application/json") {
    writeJson(response, 415, { error: "Content-Type must be application/json." });
    return;
  }

  const timings = {};
  const start = performance.now();

  try {
    const body = await readJsonBody(request);
    const file = typeof body.file === "string" ? body.file.trim() : "";
    const line = Number(body.line);

    if (!file) {
      writeJson(response, 400, { error: "File is required." });
      return;
    }

    if (!Number.isInteger(line) || line < 1) {
      writeJson(response, 400, {
        error: "Line must be a positive integer.",
      });
      return;
    }

    const result = await openFile(file, line, timings);
    const total = Math.round(performance.now() - start);
    console.log(
      `open ${result.file}:${line} in ${total}ms`,
      JSON.stringify(timings),
    );
    writeJson(response, 200, { ok: true, ...result, timings, totalMs: total });
  } catch (error) {
    const total = Math.round(performance.now() - start);
    console.error(
      `open failed in ${total}ms: ${error.message}`,
      JSON.stringify(timings),
    );
    writeJson(response, 500, { error: error.message, timings, totalMs: total });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);

  if (request.method === "POST" && url.pathname === "/api/open") {
    await handleOpenRequest(request, response);
    return;
  }

  writeJson(response, 404, { error: "Not found." });
});

server.listen(PORT, HOST, () => {
  console.log(`Neojumper running at http://localhost:${PORT}`);
});
