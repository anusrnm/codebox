//#!/usr/bin/env bun
// bun build ./build_projects.js --compile --outfile build_projects --minify --target node
import { spawn } from "child_process";
import { performance } from "perf_hooks";
import path from "path";
import fs from "fs/promises";

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

    printProjectList(projects);
    const SUCCESS = '\u2705'; // ✅
    const FAILURE = '\u274C'; // ❌
    const INTERRUPTED = '\uD83D\uDED1'; // 🛑
    const DRY_RUN = '\uD83D\uDD22'; // 🔥
    const BUILDING = '\uD83D\uDD27'; // 🔧

    
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
            console.log(`\n${INTERRUPTED} Build interrupted. Printing summary so far:`);
            printSummary();
            process.exit(130);
        }
    }



    // Flatten the projects array to count total projects and for all-parallel mode
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
    const totalProjects = flattenProjects(projects).length;
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
        // Only use spinner for serial builds (not parallel)
        const spinnerFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
        let spinnerIndex = 0;
        let spinnerInterval = null;
        let spinnerText = '';
        // Detect if this is a parallel build by checking buildProject.isParallel
        const isParallel = buildProject.isParallel === true;
        function startSpinner(text) {
            spinnerText = text;
            spinnerInterval = setInterval(() => {
                process.stdout.write(`\x1b[2K\r${spinnerFrames[spinnerIndex]} ${spinnerText} [${inProgressCount}/${totalProjects}]`);
                spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
            }, 80);
        }
        function stopSpinner(finalText) {
            if (spinnerInterval) clearInterval(spinnerInterval);
            process.stdout.write(`\x1b[2K\r${finalText} [${inProgressCount}/${totalProjects}]\n`);
        }
        if (!quiet) {
            function handleStart(evt) {
                inProgressCount++;
                if (isParallel) {
                    process.stdout.write(`${BUILDING} ${evt.dir} with ${evt.cmd} [${inProgressCount}/${totalProjects}]\n`);
                } else {
                    startSpinner(`${evt.dir} with ${evt.cmd}`);
                }
            }

            function handleDryRun(evt) {
                if (isParallel) {
                    process.stdout.write(`${DRY_RUN} Would run: ${evt.cmd} in ${evt.dir} [${inProgressCount}/${totalProjects}]\n`);
                } else {
                    stopSpinner(`${DRY_RUN} Would run: ${evt.cmd} in ${evt.dir}`);
                }
            }

            function getLogFileUrl(dir) {
                if (quiet || dryRun) return null;
                const logFile = path.join(logDir, sanitizeFilename(dir) + '.txt');
                const logFilePath = path.resolve(logFile);
                if (process.platform === 'win32') {
                    return 'file:///' + logFilePath.replace(/\\/g, '/');
                } else {
                    return 'file://' + logFilePath;
                }
            }

            function handleResult(evt) {
                const symbol = evt.type === 'success' ? SUCCESS : FAILURE;
                const logFileUrl = getLogFileUrl(evt.dir);
                if (isParallel) {
                    process.stdout.write(`${symbol} ${evt.dir} [${inProgressCount}/${totalProjects}]`);
                    if (logFileUrl) process.stdout.write(` (log: ${logFileUrl})`);
                    process.stdout.write(`\n`);
                } else {
                    let msg = `${symbol} ${evt.dir}`;
                    if (logFileUrl) msg += ` (log: ${logFileUrl})`;
                    stopSpinner(msg);
                }
            }

            localEmitter.on('progress', (evt) => {
                switch (evt.type) {
                    case 'start':
                        handleStart(evt);
                        break;
                    case 'dryrun':
                        handleDryRun(evt);
                        break;
                    case 'success':
                    case 'failure':
                        handleResult(evt);
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
    console.log(`Completed in ${formatDuration(duration)}`);
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
                directories = entries.filter(e => e.isDirectory()).map(e => path.join(arg, e.name));
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
