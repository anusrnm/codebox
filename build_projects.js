//#!/usr/bin/env bun
// bun build ./build_projects.js --compile --outfile build_projects --minify --target node
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

// Function to run Maven command in a given directory
async function runMavenCommand(dir, logFileStream, dryRun = false, lineIndex = null, lineCount = null, lineStatusArr = null, emitter = null) {
    const EventEmitter = (await import('events')).EventEmitter;
    // Always use a local emitter if not provided
    if (!emitter) emitter = new EventEmitter();
    emitter.setMaxListeners(20); // Increase if needed for high concurrency
    const cmd = await detectMavenCmd(runMavenCommand.mvndOnly);
    const overrideArgs = runMavenCommand.mavenArgs && String(runMavenCommand.mavenArgs).trim();
    let args = ["-B", "clean", "install"];
    if (!overrideArgs) {
        if (dir.includes("container")) {
            args = ["-B", "-Pdev-dist", "clean", "package"];
        }
    }
    const fullCmd = overrideArgs ? `${cmd} ${overrideArgs}` : `${cmd} ${args.join(' ')}`;
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
    
    function initDisplay() {
        if (!displayEnabled || displayInitialized) return;
        displayInitialized = true;
        
        console.log('\n' + '═'.repeat(80));
        console.log('Build Status Dashboard');
        console.log('═'.repeat(80));
        
        // Print all projects with initial status
        allProjects.forEach((dir, idx) => {
            const shortName = path.basename(dir);
            console.log(`${PENDING} ${shortName.padEnd(40)} [Pending]`);
        });
        
        console.log('═'.repeat(80) + '\n');
        
        // Save cursor position - we'll update relative to start
        displayStartLine = 0;
        
        // Start spinner animation
        displayInterval = setInterval(updateDisplay, 100);
    }
    
    function updateDisplay() {
        if (!displayEnabled || !displayInitialized) return;
        
        // Move cursor up to first project line (past empty line + footer + all project lines)
        const linesToMoveUp = allProjects.length + 2;
        process.stdout.write(`\x1b[${linesToMoveUp}A`);
        
        // Update each project line
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
            
            const lineContent = `${symbol} ${shortName.padEnd(40)} ${statusText}`;
            // Clear line, write content, move to next line
            process.stdout.write(`\x1b[2K\r${lineContent}\n`);
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

    if (!quiet) {
        initDisplay();
    } else {
        printProjectList(projects);
    }
    
    const startTime = performance.now();
    const summary = [];
    const logDir = 'build';
    const dryRun = buildInOrder.dryRun || false;
    // Removed unused mvnOnly variable
    await fs.mkdir(logDir, { recursive: true });

    function sanitizeFilename(name) {
        return name.replace(/[^a-zA-Z0-9._-]/g, '_');
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
        runMavenCommand.mvndOnly = buildInOrder.mvndOnly || false;
        runMavenCommand.mavenArgs = buildInOrder.mavenArgs || null;
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

    function printUsage() {
        console.log(`\nUsage:`);
        console.log(` build_projects.js '["dir1","dir2"]' [--quiet] [--dry-run] [--all-parallel] [--concurrency=N]`);
        console.log(` build_projects.js --file projects.json [--quiet] [--dry-run] [--all-parallel] [--concurrency=N]`);
        console.log(`\nArguments:`);
        console.log(`  JSON string or --file <jsonfile> containing an array of directories or arrays of directories.`);
        console.log(`  --quiet: Suppress per-project output, only show summary.`);
        console.log(`  --dry-run: Print what would be built, do not run Maven.`);
        console.log(`  --all-parallel: Build all projects in parallel, regardless of input structure.`);
        console.log(`  --concurrency=N: Limit the number of concurrent builds (default: 4).`);
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
        return true;
    });

    if (filteredArgs.length === 0) {
        console.error("No input provided.");
        printUsage();
        process.exit(1);
    }

    if (filteredArgs[0] === '--file' && filteredArgs[1]) {
        try {
            const fileContent = await fs.readFile(filteredArgs[1], 'utf8');
            directories = JSON.parse(fileContent);
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

    try {
        await buildInOrder(directories, quiet);
    } catch (err) {
        console.error("Build failed:", err);
        process.exit(1);
    }
}
