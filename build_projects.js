//#!/usr/bin/env bun
// bun build ./build_projects.js --compile --outfile build_projects --minify --target node
//
// Sample commands:
//   node build_projects.js '["dir1","dir2"]'
//   node build_projects.js '["dir1",["dir2","dir3"]]' --all-parallel --concurrency=8
//   node build_projects.js --file projects.json --quiet
//   node build_projects.js --file projects.txt --dry-run
//   node build_projects.js ~/workspaces/my-repos --mvnd-only
//   node build_projects.js '["dir1","dir2"]' --mvn-args="clean install -DskipTests"
//   node build_projects.js --file projects.txt --command='npm install && npm test'
//   node build_projects.js '["dir1","dir2"]' --command='echo building {dir}'
import { spawn } from "child_process";
import { performance } from "perf_hooks";
import path from "path";
import fs from "fs/promises";
import { existsSync, readFileSync } from "fs";

// Check if a directory is a Maven project
function isMavenProject(dir) {
    const pomPath = path.join(dir, 'pom.xml');
    return existsSync(pomPath);
}

// Parse pom.xml to extract parent information and artifact ID
function parsePomFile(pomPath) {
    try {
        const content = readFileSync(pomPath, 'utf8');
        
        // Extract parent information first (looking for parent block)
        const parentBlockMatch = content.match(/<parent>([\s\S]*?)<\/parent>/);
        let parentGroupId = null;
        let parentArtifactId = null;
        let parentVersion = null;
        let contentWithoutParent = content;
        
        if (parentBlockMatch) {
            const parentBlock = parentBlockMatch[1];
            const parentGroupIdMatch = parentBlock.match(/<groupId>([^<]+)<\/groupId>/);
            const parentArtifactIdMatch = parentBlock.match(/<artifactId>([^<]+)<\/artifactId>/);
            const parentVersionMatch = parentBlock.match(/<version>([^<]+)<\/version>/);
            
            parentGroupId = parentGroupIdMatch ? parentGroupIdMatch[1] : null;
            parentArtifactId = parentArtifactIdMatch ? parentArtifactIdMatch[1] : null;
            parentVersion = parentVersionMatch ? parentVersionMatch[1] : null;
            
            // Remove parent block to avoid picking up parent's artifactId/groupId
            contentWithoutParent = content.replace(/<parent>[\s\S]*?<\/parent>/, '');
        }
        
        // Extract project's own groupId, artifactId, version (after removing parent block)
        const groupIdMatch = contentWithoutParent.match(/<groupId>([^<]+)<\/groupId>/);
        const groupId = groupIdMatch ? groupIdMatch[1] : null;
        
        const artifactIdMatch = contentWithoutParent.match(/<artifactId>([^<]+)<\/artifactId>/);
        const artifactId = artifactIdMatch ? artifactIdMatch[1] : null;
        
        const versionMatch = contentWithoutParent.match(/<version>([^<]+)<\/version>/);
        const version = versionMatch ? versionMatch[1] : null;
        
        // Check if this is a parent POM (has packaging=pom)
        const packagingMatch = content.match(/<packaging>([^<]+)<\/packaging>/);
        const isParentPom = packagingMatch && packagingMatch[1] === 'pom';
        
        // Extract dependencies
        const dependencies = [];
        const dependenciesBlockMatch = content.match(/<dependencies>([\s\S]*?)<\/dependencies>/);
        
        if (dependenciesBlockMatch) {
            const dependenciesBlock = dependenciesBlockMatch[1];
            // Match individual <dependency> blocks
            const dependencyMatches = dependenciesBlock.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g);
            
            for (const depMatch of dependencyMatches) {
                const depBlock = depMatch[1];
                const depGroupIdMatch = depBlock.match(/<groupId>([^<]+)<\/groupId>/);
                const depArtifactIdMatch = depBlock.match(/<artifactId>([^<]+)<\/artifactId>/);
                
                if (depGroupIdMatch && depArtifactIdMatch) {
                    dependencies.push({
                        groupId: depGroupIdMatch[1],
                        artifactId: depArtifactIdMatch[1]
                    });
                }
            }
        }
        
        return {
            groupId,
            artifactId,
            version,
            parent: parentArtifactId ? {
                groupId: parentGroupId,
                artifactId: parentArtifactId,
                version: parentVersion
            } : null,
            isParentPom,
            dependencies
        };
    } catch (error) {
        console.error(`Failed to parse pom.xml at ${pomPath}:`, error.message);
        return null;
    }
}

// Sort projects based on parent-child dependencies (topological sort)
function sortProjectsByDependencies(projectDirs) {
    const projectInfo = new Map();
    const parentPomProjects = new Set();
    
    // First pass: collect all project information
    for (const dir of projectDirs) {
        const pomPath = path.join(dir, 'pom.xml');
        const pomData = parsePomFile(pomPath);
        if (pomData) {
            projectInfo.set(dir, pomData);
            if (pomData.isParentPom) {
                parentPomProjects.add(pomData.artifactId);
            }
        }
    }
    
    // Build dependency graph
    const graph = new Map(); // dir -> [dependent dirs]
    const inDegree = new Map(); // dir -> count of dependencies
    
    for (const dir of projectDirs) {
        graph.set(dir, []);
        inDegree.set(dir, 0);
    }
    
    // Create edges: if project A depends on B (parent or dependency), add edge B -> A
    for (const [dir, info] of projectInfo) {
        // Handle parent dependencies
        if (info.parent && info.parent.artifactId) {
            // Find the parent project directory
            for (const [parentDir, parentInfo] of projectInfo) {
                if (parentInfo.artifactId === info.parent.artifactId) {
                    graph.get(parentDir).push(dir);
                    inDegree.set(dir, inDegree.get(dir) + 1);
                    break;
                }
            }
        }
        
        // Handle regular dependencies
        if (info.dependencies && info.dependencies.length > 0) {
            for (const dep of info.dependencies) {
                // Find the dependency in our project list
                for (const [depDir, depInfo] of projectInfo) {
                    if (depInfo.artifactId === dep.artifactId && 
                        (depInfo.groupId === dep.groupId || !depInfo.groupId)) {
                        // Avoid duplicate edges
                        if (!graph.get(depDir).includes(dir)) {
                            graph.get(depDir).push(dir);
                            inDegree.set(dir, inDegree.get(dir) + 1);
                        }
                        break;
                    }
                }
            }
        }
    }
    
    // Topological sort using Kahn's algorithm
    // Modified to group projects that can be built in parallel
    const sorted = [];
    const queue = [];
    
    // Start with nodes that have no dependencies
    for (const [dir, degree] of inDegree) {
        if (degree === 0) {
            queue.push(dir);
        }
    }
    
    while (queue.length > 0) {
        // Process all projects in the current level in parallel
        const currentLevel = [...queue];
        queue.length = 0; // Clear the queue
        
        // Add current level as a parallel group if more than one project, otherwise add as single project
        if (currentLevel.length > 1) {
            sorted.push(currentLevel);
        } else if (currentLevel.length === 1) {
            sorted.push(currentLevel[0]);
        }
        
        // Reduce in-degree for all dependent projects
        for (const current of currentLevel) {
            for (const dependent of graph.get(current)) {
                inDegree.set(dependent, inDegree.get(dependent) - 1);
                if (inDegree.get(dependent) === 0) {
                    queue.push(dependent);
                }
            }
        }
    }
    
    // Check for cycles - need to count total projects including those in parallel groups
    const sortedCount = sorted.reduce((count, item) => {
        return count + (Array.isArray(item) ? item.length : 1);
    }, 0);
    
    if (sortedCount !== projectDirs.length) {
        const unsorted = projectDirs.filter(dir => !sorted.includes(dir));
        console.warn('\n⚠️  Warning: Circular dependency detected or some projects could not be sorted.');
        console.warn('Projects involved in circular dependency:');
        
        for (const dir of unsorted) {
            const info = projectInfo.get(dir);
            const dirName = path.basename(dir);
            
            if (info) {
                let depInfo = `  - ${dirName} (${info.artifactId})`;
                const deps = [];
                
                if (info.parent) {
                    deps.push(`parent: ${info.parent.artifactId}`);
                }
                
                if (info.dependencies && info.dependencies.length > 0) {
                    // Only show dependencies that are in our project list
                    const localDeps = info.dependencies.filter(dep => 
                        Array.from(projectInfo.values()).some(pi => 
                            pi.artifactId === dep.artifactId && 
                            (pi.groupId === dep.groupId || !pi.groupId)
                        )
                    );
                    if (localDeps.length > 0) {
                        deps.push(`depends on: ${localDeps.map(d => d.artifactId).join(', ')}`);
                    }
                }
                
                if (deps.length > 0) {
                    console.warn(`${depInfo} [${deps.join('; ')}]`);
                } else {
                    console.warn(depInfo);
                }
            } else {
                console.warn(`  - ${dirName}`);
            }
        }
        
        console.warn('Using original directory order for these projects.\n');
        return projectDirs;
    }
    
    return sorted;
}

let mavenCmd = null;
// Return 'mvn' by default; return 'mvnd' only when explicitly requested
async function detectMavenCmd(mvndOnly = false) {
    if (mvndOnly) return 'mvnd';
    if (mavenCmd) return mavenCmd;
    mavenCmd = 'mvn';
    return mavenCmd;
}

async function resolveBuildCommand(dir) {
    const customCommand = runMavenCommand.command && String(runMavenCommand.command).trim();
    if (customCommand) {
        return customCommand.includes('{dir}') ? customCommand.replaceAll('{dir}', dir) : customCommand;
    }

    const cmd = await detectMavenCmd(runMavenCommand.mvndOnly);
    const overrideArgs = runMavenCommand.mavenArgs && String(runMavenCommand.mavenArgs).trim();
    if (overrideArgs) {
        return `${cmd} ${overrideArgs}`;
    }

    const args = dir.includes("container")
        ? ["-B", "-Pdev-dist", "clean", "package"]
        : ["-B", "clean", "install"];
    return `${cmd} ${args.join(' ')}`;
}

// Function to run a Maven (or custom) command in a given directory
async function runMavenCommand(dir, logFileStream, dryRun = false, lineIndex = null, lineCount = null, lineStatusArr = null, emitter = null) {
    const EventEmitter = (await import('events')).EventEmitter;
    // Always use a local emitter if not provided
    if (!emitter) emitter = new EventEmitter();
    emitter.setMaxListeners(20); // Increase if needed for high concurrency
    const fullCmd = await resolveBuildCommand(dir);
    // Emit progress event before starting
    emitter.emit('progress', { type: 'start', dir, cmd: fullCmd });
    if (dryRun) {
        emitter.emit('progress', { type: 'dryrun', dir, cmd: fullCmd });
        return { success: true, output: '[DRY RUN] No output.', duration: 0, warnings: 0, errors: 0 };
    }
    const start = performance.now();
    return new Promise((resolve) => {
        let child;
        child = spawn(fullCmd, { cwd: dir, shell: true });
        let output = "";
        let hadError = false;

        const onStdout = (data) => {
            const str = data.toString();
            output += str;
            logFileStream?.write(str);
            emitter.emit('progress', { type: 'stdout', dir, data: str });
        };
        const onStderr = (data) => {
            const str = data.toString();
            output += str;
            logFileStream?.write(str);
            emitter.emit('progress', { type: 'stderr', dir, data: str });
        };
        const onError = (err) => {
            hadError = true;
            output += `\nProcess error: ${err.message}`;
            logFileStream?.write(`\nProcess error: ${err.message}`);
            emitter.emit('progress', { type: 'error', dir, error: err });
        };
        const onClose = (code) => {
            const duration = performance.now() - start;
            // Count warnings and errors
            const warnCount = (output.match(/\bWARNING\b/gi) || []).length;
            const errorCount = (output.match(/\bERROR\b/gi) || []).length;
            if (code === 0 && !hadError) {
                emitter.emit('progress', { type: 'success', dir, duration, warnings: warnCount, errors: errorCount });
                cleanup();
                resolve({ success: true, output, duration, warnings: warnCount, errors: errorCount });
            } else {
                emitter.emit('progress', { type: 'failure', dir, duration, warnings: warnCount, errors: errorCount, output });
                cleanup();
                resolve({ success: false, output: `Error in ${dir}: ${output}`, duration, warnings: warnCount, errors: errorCount });
            }
        };
        function cleanup() {
            child.stdout.off("data", onStdout);
            child.stderr.off("data", onStderr);
            child.off("error", onError);
            child.off("close", onClose);
            // Remove all listeners from emitter
            emitter.removeAllListeners();
        }
        child.stdout.on("data", onStdout);
        child.stderr.on("data", onStderr);
        child.on("error", onError);
        child.on("close", onClose);
    });
}

// Main build function with quiet option
async function buildInOrder(projects, quiet = false) {
    // Print the list of projects to be built, showing parallel ones in the same line
    function printProjectList(projects) {
        console.log("Projects to build:");
        projects.forEach(proj => {
            if (Array.isArray(proj)) {
                console.log("  ", proj.join("  |  "));
            } else {
                console.log("  ", proj);
            }
        });
        console.log("");
    }

    const SUCCESS = '\u2705'; // ✅
    const FAILURE = '\u274C'; // ❌
    const INTERRUPTED = '\uD83D\uDED1'; // 🛑
    const DRY_RUN = '\uD83D\uDD22'; // 🔥
    const BUILDING = '\uD83D\uDD27'; // 🔧
    const PENDING = '\u23F3'; // ⏳
    const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    const HIDE_CURSOR = '\x1b[?25l';
    const SHOW_CURSOR = '\x1b[?25h';
    const ENTER_ALTERNATE_SCREEN = '\x1b[?1049h\x1b[2J\x1b[H';
    const EXIT_ALTERNATE_SCREEN = '\x1b[?1049l';

    // Flatten projects to create status display
    function flattenProjects(arr) {
        return arr.reduce((acc, item) => {
            if (Array.isArray(item)) {
                acc.push(...flattenProjects(item));
            } else {
                acc.push(item);
            }
            return acc;
        }, []);
    }
    
    const allProjects = flattenProjects(projects);
    const projectStatus = new Map(); // dir -> {status, symbol, duration, warnings, errors, startLine}
    
    // Initialize all projects as pending
    allProjects.forEach(dir => {
        projectStatus.set(dir, {
            status: 'pending',
            symbol: PENDING,
            duration: null,
            warnings: null,
            errors: null,
            startLine: null
        });
    });
    
    // Display manager for GUI-like output
    let displayEnabled = !quiet;
    let displayStartLine = 0;
    let spinnerIndex = 0;
    let displayInterval = null;
    let displayInitialized = false;
    let lastLineContent = null; // tracks previously rendered content per line, to skip unchanged lines
    let cursorHidden = false;

    // Interactive log viewer support. Only enabled when both stdin and stdout
    // are a TTY so raw key handling and alternate-screen rendering are safe.
    let selectedIndex = 0;
    let logViewerActive = false;
    let logViewerVisible = false;
    let logViewerGeneration = 0;
    let logViewerDir = null;
    let logViewerLines = [];
    let logViewerOffset = 0;
    let logViewerColumn = 0;
    const interactiveTTY = displayEnabled
        && !!process.stdin.isTTY
        && !!process.stdout.isTTY
        && typeof process.stdin.setRawMode === 'function';

    function hideCursor() {
        if (!cursorHidden) {
            process.stdout.write(HIDE_CURSOR);
            cursorHidden = true;
        }
    }

    function showCursor() {
        if (cursorHidden) {
            process.stdout.write(SHOW_CURSOR);
            cursorHidden = false;
        }
    }
    // Safety net: never leave the user's terminal with a hidden cursor,
    // even if the process exits unexpectedly (crash, uncaught exception, etc.)
    process.on('exit', showCursor);
    process.on('exit', () => {
        if (logViewerVisible) process.stdout.write(EXIT_ALTERNATE_SCREEN);
    });

    function initDisplay() {
        if (!displayEnabled || displayInitialized) return;
        displayInitialized = true;
        
        console.log('\n' + '═'.repeat(80));
        console.log('Build Status Dashboard');
        if (interactiveTTY) {
            console.log('↑/↓ select • Enter/Space open log • Ctrl+C cancels build');
        }
        console.log('═'.repeat(80));
        
        // Print all projects with initial status
        allProjects.forEach((dir, idx) => {
            const shortName = path.basename(dir);
            const pointer = interactiveTTY && idx === selectedIndex ? '➤ ' : '  ';
            console.log(`${pointer}${PENDING} ${shortName.padEnd(40)} [Pending]`);
        });
        
        console.log('═'.repeat(80) + '\n');
        
        // Save cursor position - we'll update relative to start
        displayStartLine = 0;
        lastLineContent = new Array(allProjects.length).fill(null);
        
        // Hide the cursor so redraws don't visibly jump/blink down the list
        hideCursor();
        
        // Start spinner animation
        displayInterval = setInterval(updateDisplay, 100);
    }
    
    function updateDisplay() {
        if (!displayEnabled || !displayInitialized) return;
        if (logViewerActive) return; // don't repaint beneath the alternate-screen log viewer
        
        // Move cursor up to first project line (past empty line + footer + all project lines)
        const linesToMoveUp = allProjects.length + 2;
        process.stdout.write(`\x1b[${linesToMoveUp}A`);
        
        // Update each project line, but only touch lines whose content actually changed
        // since the last frame. This avoids needless clear+write churn every 100ms.
        allProjects.forEach((dir, idx) => {
            const status = projectStatus.get(dir);
            const shortName = path.basename(dir);
            
            let statusText = '';
            let symbol = status.symbol;
            
            if (status.status === 'building') {
                symbol = SPINNER[spinnerIndex % SPINNER.length];
                statusText = '[Building...]';
            } else if (status.status === 'pending') {
                statusText = '[Pending]';
            } else if (status.status === 'success') {
                const durationStr = status.duration ? ` (${formatProjectDuration(status.duration)})` : '';
                const warnStr = status.warnings !== null ? ` W:${status.warnings}` : '';
                const errStr = status.errors !== null ? ` E:${status.errors}` : '';
                statusText = `[Success${durationStr}${warnStr}${errStr}]`;
            } else if (status.status === 'failure') {
                const durationStr = status.duration ? ` (${formatProjectDuration(status.duration)})` : '';
                statusText = `[Failed${durationStr}]`;
            } else if (status.status === 'dryrun') {
                statusText = '[Dry Run]';
            }
            
            const pointer = interactiveTTY && idx === selectedIndex ? '➤ ' : '  ';
            const lineContent = `${pointer}${symbol} ${shortName.padEnd(40)} ${statusText}`;
            if (lastLineContent[idx] !== lineContent) {
                // Clear line, write content, move to next line
                process.stdout.write(`\x1b[2K\r${lineContent}\n`);
                lastLineContent[idx] = lineContent;
            } else {
                // Content unchanged (e.g. finished or still-pending project): just advance
                // the cursor to the next line without rewriting anything.
                process.stdout.write(`\x1b[1B`);
            }
        });
        
        // Now cursor is at footer line, move it back to original position (after empty line)
        process.stdout.write(`\x1b[2B`);
        
        spinnerIndex++;
    }
    
    function formatProjectDuration(ms) {
        if (!ms) return '';
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
    }
    
    function cleanupDisplay() {
        if (logViewerActive) {
            closeLogViewer();
        }
        if (displayInterval) {
            clearInterval(displayInterval);
            displayInterval = null;
        }
        if (displayEnabled && displayInitialized) {
            // Do one final update to show final status
            spinnerIndex = 0; // Reset spinner for final display
            updateDisplay();
            // Cursor is already positioned after the dashboard, just add a newline
            console.log('');
        }
        showCursor();
        keyboardCleanup();
    }
    
    function updateProjectStatus(dir, status, details = {}) {
        if (!projectStatus.has(dir)) return;
        
        const current = projectStatus.get(dir);
        projectStatus.set(dir, {
            ...current,
            status,
            symbol: details.symbol || current.symbol,
            duration: details.duration !== undefined ? details.duration : current.duration,
            warnings: details.warnings !== undefined ? details.warnings : current.warnings,
            errors: details.errors !== undefined ? details.errors : current.errors
        });
        
        if (displayEnabled) {
            updateDisplay();
        }
    }

    runMavenCommand.mvndOnly = buildInOrder.mvndOnly || false;
    runMavenCommand.mavenArgs = buildInOrder.mavenArgs || null;
    runMavenCommand.command = buildInOrder.command || null;

    if (!quiet) {
        const commands = await Promise.all(allProjects.map(async dir => ({
            dir,
            command: await resolveBuildCommand(dir)
        })));
        const uniqueCommands = new Set(commands.map(({ command }) => command));
        if (commands.length === 0) {
            console.log('Command: (none)');
        } else if (uniqueCommands.size === 1) {
            console.log(`Command: ${commands[0].command}`);
        } else {
            console.log('Commands:');
            commands.forEach(({ dir, command }) => console.log(`  ${dir}: ${command}`));
        }
        initDisplay();
    } else {
        printProjectList(projects);
    }
    
    const startTime = performance.now();
    const summary = [];
    const logDir = '.build';
    const dryRun = buildInOrder.dryRun || false;
    // Removed unused mvnOnly variable
    await fs.mkdir(logDir, { recursive: true });

    function sanitizeFilename(name) {
        return name.replace(/[^a-zA-Z0-9._-]/g, '_');
    }

    // ---- Interactive full-log viewer ----
    const LOG_VIEWER_OVERHEAD_LINES = 2; // header + status/help footer

    function getLogFilePath(dir) {
        return path.join(logDir, sanitizeFilename(dir) + '.txt');
    }

    async function readLogContents(dir) {
        try {
            const content = await fs.readFile(getLogFilePath(dir), 'utf8');
            const lines = content.split(/\r?\n/);
            if (lines.length && lines[lines.length - 1] === '') lines.pop(); // drop trailing blank from final \n
            return lines;
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
    }

    function getLogViewerBodyHeight() {
        return Math.max(1, (process.stdout.rows || 24) - LOG_VIEWER_OVERHEAD_LINES);
    }

    function stripTerminalSequences(line) {
        return line
            .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    }

    function renderLogViewer() {
        if (!logViewerActive) return;

        const cols = process.stdout.columns || 100;
        const bodyHeight = getLogViewerBodyHeight();
        const maxLineWidth = Math.max(1, cols - 1);
        const truncate = (line) => String(line).length > maxLineWidth
            ? String(line).slice(0, Math.max(0, maxLineWidth - 1)) + '…'
            : String(line);

        const maxOffset = Math.max(0, logViewerLines.length - bodyHeight);
        const maxContentWidth = logViewerLines.reduce((max, line) => Math.max(max, line.length), 0);
        const maxColumn = Math.max(0, maxContentWidth - maxLineWidth);
        logViewerOffset = Math.max(0, Math.min(logViewerOffset, maxOffset));
        logViewerColumn = Math.max(0, Math.min(logViewerColumn, maxColumn));
        const visibleLines = logViewerLines.slice(logViewerOffset, logViewerOffset + bodyHeight);
        const body = visibleLines.length > 0
            ? visibleLines.map(line => line.slice(logViewerColumn, logViewerColumn + maxLineWidth))
            : ['(no output captured yet for this project)'];
        const firstLine = logViewerLines.length > 0 ? logViewerOffset + 1 : 0;
        const lastLine = logViewerLines.length > 0 ? logViewerOffset + visibleLines.length : 0;
        const header = truncate(`Log: ${logViewerDir}`);
        const footer = truncate(
            `Lines ${firstLine}-${lastLine}/${logViewerLines.length} Col ${logViewerColumn + 1} | ↑/↓ scroll | ←/→ horizontal | PgUp/PgDn | Home/End | r refresh | q/Esc close`
        );

        process.stdout.write('\x1b[2J\x1b[H' + [header, ...body, footer].join('\n'));
    }

    async function loadLogViewer({ followEnd = false } = {}) {
        if (!logViewerActive || !logViewerDir) return;
        const generation = logViewerGeneration;

        try {
            const lines = await readLogContents(logViewerDir);
            if (!logViewerActive || generation !== logViewerGeneration) return;
            logViewerLines = (lines || []).map(line => stripTerminalSequences(line).replace(/\r/g, ''));
            if (followEnd) {
                logViewerOffset = Math.max(0, logViewerLines.length - getLogViewerBodyHeight());
            }
        } catch (error) {
            if (!logViewerActive || generation !== logViewerGeneration) return;
            logViewerLines = [`Unable to read log: ${error.message}`];
            logViewerOffset = 0;
        }

        renderLogViewer();
    }

    async function openLogViewer(dir) {
        if (logViewerActive || !dir) return;
        logViewerActive = true;
        logViewerDir = dir;
        logViewerLines = [];
        logViewerOffset = 0;
        logViewerColumn = 0;
        logViewerGeneration++;
        logViewerVisible = true;
        process.stdout.write(ENTER_ALTERNATE_SCREEN);
        renderLogViewer();
        await loadLogViewer({ followEnd: true });
    }

    function closeLogViewer() {
        if (!logViewerActive) return;
        logViewerActive = false;
        logViewerGeneration++;
        logViewerDir = null;
        logViewerLines = [];
        logViewerOffset = 0;
        logViewerColumn = 0;
        if (logViewerVisible) {
            process.stdout.write(EXIT_ALTERNATE_SCREEN);
            logViewerVisible = false;
        }
        // The underlying dashboard is restored with its original cursor position.
        // Invalidate every cached row so status changes accumulated while viewing
        // are repainted immediately, including otherwise unchanged pending entries.
        lastLineContent = new Array(allProjects.length).fill(null);
        if (displayEnabled && displayInitialized && !displayInterval) {
            displayInterval = setInterval(updateDisplay, 100);
        }
        updateDisplay();
    }

    function moveSelection(delta) {
        if (!allProjects.length || logViewerActive) return;
        selectedIndex = (selectedIndex + delta + allProjects.length) % allProjects.length;
        updateDisplay(); // repaint right away so the pointer moves without waiting for the next tick
    }

    function scrollLogViewer(delta) {
        if (!logViewerActive) return;
        const maxOffset = Math.max(0, logViewerLines.length - getLogViewerBodyHeight());
        logViewerOffset = Math.max(0, Math.min(logViewerOffset + delta, maxOffset));
        renderLogViewer();
    }

    let keyboardCleanup = () => {};
    if (interactiveTTY) {
        const readline = await import('readline');
        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.resume();

        const onKeypress = (str, key) => {
            if (!key) return;
            if (key.ctrl && key.name === 'c') {
                handleInterrupt();
                return;
            }
            if (logViewerActive) {
                const pageSize = getLogViewerBodyHeight();
                if (key.name === 'escape' || key.name === 'q') {
                    closeLogViewer();
                } else if (key.name === 'up' || key.name === 'k') {
                    scrollLogViewer(-1);
                } else if (key.name === 'down' || key.name === 'j') {
                    scrollLogViewer(1);
                } else if (key.name === 'left' || key.name === 'h') {
                    logViewerColumn = Math.max(0, logViewerColumn - 8);
                    renderLogViewer();
                } else if (key.name === 'right' || key.name === 'l') {
                    logViewerColumn += 8;
                    renderLogViewer();
                } else if (key.name === 'pageup') {
                    scrollLogViewer(-pageSize);
                } else if (key.name === 'pagedown' || key.name === 'space') {
                    scrollLogViewer(pageSize);
                } else if (key.name === 'home') {
                    logViewerOffset = 0;
                    renderLogViewer();
                } else if (key.name === 'end') {
                    logViewerOffset = Math.max(0, logViewerLines.length - pageSize);
                    renderLogViewer();
                } else if (key.name === 'r') {
                    loadLogViewer().catch(error => {
                        logViewerLines = [`Unable to refresh log: ${error.message}`];
                        logViewerOffset = 0;
                        renderLogViewer();
                    });
                }
                return;
            }
            if (key.name === 'up' || key.name === 'k') {
                moveSelection(-1);
            } else if (key.name === 'down' || key.name === 'j') {
                moveSelection(1);
            } else if (key.name === 'return' || key.name === 'space') {
                openLogViewer(allProjects[selectedIndex]).catch(error => {
                    if (logViewerActive) {
                        logViewerLines = [`Unable to open log: ${error.message}`];
                        logViewerOffset = 0;
                        renderLogViewer();
                    }
                });
            }
        };
        const onResize = () => {
            if (logViewerActive) renderLogViewer();
        };
        process.stdin.on('keypress', onKeypress);
        process.stdout.on('resize', onResize);

        keyboardCleanup = () => {
            process.stdin.off('keypress', onKeypress);
            process.stdout.off('resize', onResize);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();
        };
    }

    let interrupted = false;

    function printSummary() {
        function formatProjectDuration(ms) {
            if (!ms) return '';
            const s = Math.floor(ms / 1000);
            const m = Math.floor(s / 60);
            const sec = s % 60;
            return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
        }
        if (!dryRun) {
            console.log("\nBuild Summary:");
            summary.forEach(({ dir, success, logFile, duration, warnings, errors }) => {
                const symbol = success ? SUCCESS : FAILURE;
                const dura = formatProjectDuration(duration);
                const durStr = dura ? `(${dura})` : '';
                const warnStr = warnings !== undefined ? `, warnings: ${warnings}` : '';
                const errStr = errors !== undefined ? `, errors: ${errors}` : '';
                let logStr = '';
                if (logFile) {
                    const absLogFile = path.resolve(logFile);
                    logStr = ` (log: ${absLogFile})`;
                }
                console.log(`${symbol} ${dir}${durStr}${warnStr}${errStr}${logStr}`);
            });
        }
    }

    function handleInterrupt() {
        if (!interrupted) {
            interrupted = true;
            cleanupDisplay();
            console.log(`\n${INTERRUPTED} Build interrupted. Printing summary so far:`);
            printSummary();
            process.exit(130);
        }
    }

    const totalProjects = allProjects.length;
    let inProgressCount = 0;

    // Support for all-parallel mode
    const allParallel = buildInOrder.allParallel === true;
    async function buildProject(dir, lineIndex = null, lineCount = null, lineStatusArr = null) {
        const logFile = path.join(logDir, sanitizeFilename(dir) + '.txt');
        const logStream = (!quiet && !dryRun) ? (await import('fs')).createWriteStream(logFile) : null;
        // Always use a local emitter for this build
        const { EventEmitter } = await import('events');
        const localEmitter = new EventEmitter();
        localEmitter.setMaxListeners(20); // Increase if needed
        
        if (!quiet) {
            localEmitter.on('progress', (evt) => {
                switch (evt.type) {
                    case 'start':
                        inProgressCount++;
                        updateProjectStatus(evt.dir, 'building', { symbol: BUILDING });
                        break;
                    case 'dryrun':
                        updateProjectStatus(evt.dir, 'dryrun', { symbol: DRY_RUN });
                        break;
                    case 'success':
                        updateProjectStatus(evt.dir, 'success', {
                            symbol: SUCCESS,
                            duration: evt.duration,
                            warnings: evt.warnings,
                            errors: evt.errors
                        });
                        break;
                    case 'failure':
                        updateProjectStatus(evt.dir, 'failure', {
                            symbol: FAILURE,
                            duration: evt.duration,
                            warnings: evt.warnings,
                            errors: evt.errors
                        });
                        break;
                    default:
                        break;
                }
            });
        }
        const result = await runMavenCommand(dir, logStream, dryRun, lineIndex, lineCount, lineStatusArr, localEmitter);
        // Remove all listeners after build to prevent leaks
        localEmitter.removeAllListeners();
        const logFilePath = !quiet && !dryRun ? path.resolve(logFile) : undefined;
        summary.push({
            dir,
            success: result.success,
            logFile: logFilePath,
            duration: result.duration,
            warnings: result.warnings,
            errors: result.errors
        });
        return result;
    }

    // Concurrency limit for parallel builds
    const concurrency = typeof buildInOrder.concurrency === 'number' && buildInOrder.concurrency > 0 ? buildInOrder.concurrency : 4;
    async function buildParallelGroup(group) {
        buildProject.isParallel = true;
        const results = [];
        let idx = 0;
        let running = 0;
        let resolveAll;
        const allDone = new Promise(res => { resolveAll = res; });
        function next() {
            if (idx >= group.length) {
                if (running === 0) resolveAll();
                return;
            }
            const dir = group[idx++];
            running++;
            buildProject(dir).then((result) => {
                results.push(result);
            }).finally(() => {
                running--;
                next();
            });
        }
        // Start up to concurrency limit
        for (let i = 0; i < Math.min(concurrency, group.length); i++) {
            next();
        }
        await allDone;
        buildProject.isParallel = false;
        return results;
    }

    process.on('SIGINT', handleInterrupt);

    if (allParallel) {
        // Build all projects in parallel, regardless of input structure
        await buildParallelGroup(flattenProjects(projects));
    } else {
        for (const project of projects) {
            if (Array.isArray(project)) {
                await buildParallelGroup(project);
            } else {
                await buildProject(project);
            }
        }
    }

    const duration = performance.now() - startTime;
    cleanupDisplay();
    console.log(`\nCompleted in ${formatDuration(duration)}`);
    printSummary();
}

function formatDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    const parts = [];
    if (hours > 0) {
        parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
    }
    if (minutes > 0) {
        parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);
    }
    if (remainingSeconds > 0) {
        parts.push(
            `${remainingSeconds} second${remainingSeconds !== 1 ? "s" : ""}`,
        );
    }

    return parts.join(", ") || "0 seconds";
}


// Export the buildInOrder function for external use
export { buildInOrder };

// If this script is run directly, parse arguments and call buildInOrder
if (import.meta.main) {
    const args = process.argv.slice(2);
    let directories;
    let quiet = false;
    let dryRun = false;
    let mvndOnly = false;
    let allParallel = false;
    let concurrency = 4;
    let mvnArgs = null; // override for Maven arguments
    let command = null; // full custom command override, replacing Maven entirely

    function parseProjectListContent(content) {
        const trimmed = String(content || '').trim();
        if (!trimmed) {
            return [];
        }

        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed;
            }
        } catch {
            // Fall through to newline-delimited parsing below.
        }

        const lines = trimmed
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);

        if (lines.length > 0) {
            return lines;
        }

        throw new Error('Expected a JSON array or a newline-delimited list of project directories.');
    }

    function printUsage() {
        console.log(`\nUsage:`);
        console.log(` build_projects.js '["dir1","dir2"]' [--quiet] [--dry-run] [--all-parallel] [--concurrency=N]`);
        console.log(` build_projects.js --file projects.json [--quiet] [--dry-run] [--all-parallel] [--concurrency=N]`);
        console.log(` build_projects.js --file projects.txt [--quiet] [--dry-run] [--all-parallel] [--concurrency=N]`);
        console.log(`\nArguments:`);
        console.log(`  JSON string, JSON file, or --file <file> containing either a JSON array or one project directory per line.`);
        console.log(`  --quiet: Suppress per-project output, only show summary.`);
        console.log(`  --dry-run: Print what would be built, do not run Maven.`);
        console.log(`  --all-parallel: Build all projects in parallel, regardless of input structure.`);
        console.log(`  --concurrency=N: Limit the number of concurrent builds (default: 4).`);
        console.log(`  --mvn-args=<args>: Override the Maven args (still runs mvn/mvnd).`);
        console.log(`  --command=<cmd>: Run an arbitrary shell command per project instead of Maven. Use {dir} to reference the project path.`);
    }

    // Remove --quiet, --dry-run, --mvnd-only, --all-parallel, --concurrency if present
    const filteredArgs = args.filter(arg => {
        if (arg === '--quiet') {
            quiet = true;
            return false;
        }
        if (arg === '--dry-run') {
            dryRun = true;
            return false;
        }
        if (arg === '--mvnd-only') {
            mvndOnly = true;
            return false;
        }
        if (arg === '--all-parallel') {
            allParallel = true;
            return false;
        }
        if (arg.startsWith('--concurrency=')) {
            const val = parseInt(arg.split('=')[1], 10);
            if (!isNaN(val) && val > 0) concurrency = val;
            return false;
        }
        if (arg.startsWith('--mvn-args=')) {
            // Everything after '=' is taken as a single string of args
            mvnArgs = arg.substring('--mvn-args='.length);
            return false;
        }
        if (arg.startsWith('--command=')) {
            // Full custom command to run per project, replacing Maven entirely
            command = arg.substring('--command='.length);
            return false;
        }
        return true;
    });

    const unknownOptions = filteredArgs.filter(arg => arg.startsWith('--') && arg !== '--file');
    if (unknownOptions.length > 0) {
        console.error(`Unknown option${unknownOptions.length > 1 ? 's' : ''}: ${unknownOptions.join(', ')}`);
        printUsage();
        process.exit(1);
    }

    if (filteredArgs.length === 0) {
        console.error("No input provided.");
        printUsage();
        process.exit(1);
    }

    if (filteredArgs[0] === '--file' && filteredArgs[1]) {
        try {
            const fileContent = await fs.readFile(filteredArgs[1], 'utf8');
            directories = parseProjectListContent(fileContent);
        } catch (error) {
            console.error(`Failed to read or parse file: ${filteredArgs[1]}\n${error}`);
            process.exit(1);
        }
    } else {
        // If the argument is a directory, use all its subdirectories as the project list
        const arg = filteredArgs[0];
        try {
            // Try to parse as JSON array first
            directories = JSON.parse(arg);
        } catch {
            // Not a JSON array, check if it's a directory
            const stat = await fs.stat(arg);
            if (stat.isDirectory()) {
                // List all subdirectories
                const entries = await fs.readdir(arg, { withFileTypes: true });
                const allSubdirs = entries.filter(e => e.isDirectory()).map(e => path.join(arg, e.name));
                
                // Filter to only Maven projects (those with pom.xml)
                directories = allSubdirs.filter(dir => isMavenProject(dir));
                
                if (directories.length === 0) {
                    console.error(`No Maven projects found in directory: ${arg}`);
                    process.exit(1);
                }
                
                console.log(`Found ${directories.length} Maven project(s) in ${arg}`);
                
                // Sort by dependencies if not using all-parallel mode
                if (!allParallel) {
                    console.log('Analyzing pom.xml files to determine build order...');
                    directories = sortProjectsByDependencies(directories);
                }
            } else {
                console.error("Invalid input. Please provide a valid JSON array, use --file <jsonfile>, or pass a directory containing projects.");
                printUsage();
                process.exit(1);
            }
                
        }
    }

    if (!Array.isArray(directories)) {
        console.error("Input must be a JSON array.");
        printUsage();
        process.exit(1);
    }

    // Pass dryRun, mvndOnly, allParallel, and concurrency to buildInOrder
    buildInOrder.dryRun = dryRun;
    buildInOrder.mvndOnly = mvndOnly;
    buildInOrder.allParallel = allParallel;
    buildInOrder.concurrency = concurrency;
    buildInOrder.mavenArgs = mvnArgs;
    buildInOrder.command = command;

    try {
        await buildInOrder(directories, quiet);
    } catch (err) {
        console.error("Build failed:", err);
        process.exit(1);
    }
}
