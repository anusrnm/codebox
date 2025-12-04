#!/usr/bin/env node

import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const ERROR = '❌';
const INFO = 'ℹ️';

let abort = false;
let runningProcs = [];

process.on('SIGINT', () => {
    console.log('\nAborting...');
    abort = true;
    for (const proc of runningProcs) {
        proc.kill('SIGTERM');
    }
    runningProcs = [];
});

const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIndex = 0;
let spinnerInterval;

function getDirSize(dirPath) {
    let total = 0;
    try {
        const entries = readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dirPath, entry.name);
            try {
                if (entry.isSymbolicLink()) continue;
                if (entry.isFile()) {
                    total += statSync(fullPath).size;
                } else if (entry.isDirectory()) {
                    total += getDirSize(fullPath);
                }
            } catch { continue; }
        }
    } catch { }
    return total;
}

function formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${bytes.toFixed(2)} ${units[i]}`;
}

function findTargetDirs(basePath) {
    const dirs = [];
    for (const item of readdirSync(basePath)) {
        const itemPath = join(basePath, item);
        const targetFolder = join(itemPath, 'target');
        const pom = join(itemPath, 'pom.xml');
        if (
            existsSync(targetFolder) &&
            statSync(targetFolder).isDirectory() &&
            existsSync(pom)
        ) {
            dirs.push(itemPath);
        }
    }
    return dirs;
}


function resolveMvnPath() {
    if (os.platform() === 'win32') {
        return 'mvn.cmd';
    }
    return 'mvn';
}

function parseArgs() {
    const args = process.argv.slice(2);
    let basePath = process.cwd();
    let dryRun = false;
    if (args.length > 0) {
        if (args.includes('--dry-run')) {
            dryRun = true;
            basePath = args.find(a => a !== '--dry-run') || basePath;
        } else {
            basePath = args[0];
        }
    }
    return { basePath, dryRun };
}

function validateBasePath(basePath) {
    if (!existsSync(basePath)) {
        console.error(`${ERROR} Base path '${basePath}' does not exist.`);
        process.exit(1);
    }
    if (!statSync(basePath).isDirectory()) {
        console.error(`${ERROR} Base path '${basePath}' is not a directory.`);
        process.exit(1);
    }
}

function reportTargetDirs(targetDirs, targetSizes) {
    console.log(`${INFO} Found ${targetDirs.length} Maven project(s) to clean.`);
    let totalBytes = Object.values(targetSizes).reduce((a, b) => a + b, 0);
    console.log(`${INFO} Total disk space that will be reclaimed: ${formatSize(totalBytes)}`);
    console.log(`\n${INFO} Directories to be cleaned:`);
    for (const dirPath of targetDirs) {
        const size = targetSizes[dirPath] || 0;
        console.log(` - ${dirPath} (${formatSize(size)})`);
    }
}

function cleanMavenInTargetDirAsync(itemPath, mvnPath) {
    return new Promise((resolve) => {
        const proc = spawn(`${mvnPath} -q clean`, [], { cwd: itemPath, shell: true });
        runningProcs.push(proc);
        proc.on('close', (code) => {
            runningProcs = runningProcs.filter(p => p !== proc);
            if (code === 0) {
                resolve({ path: itemPath, error: '' });
            } else {
                resolve({ path: itemPath, error: `Error executing mvn clean: exit code ${code}` });
            }
        });
        proc.on('error', (e) => {
            runningProcs = runningProcs.filter(p => p !== proc);
            resolve({ path: itemPath, error: `OS error: ${e.message}` });
        });
    });
}

async function cleanDirs(targetDirs, mvnPath, concurrency = os.cpus().length) {
    const cleaned = [];
    const errors = [];
    let shared = { index: 0, processed: 0 };

    spinnerInterval = setInterval(() => {
        process.stdout.write(`\r${spinnerChars[spinnerIndex++ % spinnerChars.length]} Cleaning... ${shared.processed}/${targetDirs.length}`);
    }, 100);

    async function worker() {
        while (true) {
            if (abort) break;
            let dirPath;
            // Atomically increment index
            if (shared.index < targetDirs.length) {
                dirPath = targetDirs[shared.index++];
            } else {
                break;
            }
            const result = await cleanMavenInTargetDirAsync(dirPath, mvnPath);
            shared.processed++;
            if (result.error) {
                errors.push(result);
            } else {
                cleaned.push(result.path);
            }
        }
    }

    await Promise.all(new Array(concurrency).fill().map(worker));
    clearInterval(spinnerInterval);
    if (abort) {
        process.stdout.write('\rAborted.\n');
    } else {
        process.stdout.write('\rDone cleaning.\n');
    }
    return { cleaned, errors };
}

function reportCleaned(cleaned, errors, targetSizes) {
    console.log(`\n${INFO} Cleaned directories:`);
    for (const c of cleaned) {
        console.log(` - ${c}`);
    }
    console.log(` ${INFO} Total cleaned directories: ${cleaned.length}`);

    if (errors.length > 0) {
        console.log(`\n${ERROR} Errors encountered:`);
        for (const { path, error } of errors) {
            console.log(` - ${path}: ${error}`);
        }
        console.log(` ${ERROR} Total errors: ${errors.length}`);
    }

    const reclaimedBytes = cleaned.reduce((sum, path) => sum + (targetSizes[path] || 0), 0);
    console.log(`\n${INFO} Total disk space reclaimed: ${formatSize(reclaimedBytes)}`);
}

function getTargetSizes(targetDirs) {
    const targetSizes = {};
    for (const dirPath of targetDirs) {
        const targetFolder = join(dirPath, 'target');
        if (existsSync(targetFolder)) {
            targetSizes[dirPath] = getDirSize(targetFolder);
        }
    }
    return targetSizes;
}

async function main() {
    const { basePath, dryRun } = parseArgs();
    validateBasePath(basePath);

    const startTime = process.hrtime.bigint();

    const mvnPath = resolveMvnPath();
    const targetDirs = findTargetDirs(basePath);

    if (targetDirs.length === 0) {
        const absolutePath = resolve(basePath);
        console.log(`${ERROR} No Maven target directories found in '${absolutePath}'.`);
        return;
    }

    const targetSizes = getTargetSizes(targetDirs);
    reportTargetDirs(targetDirs, targetSizes);

    if (dryRun) {
        console.log(`\n${INFO} Dry run: No directories were cleaned.`);
        return;
    }

    const { cleaned, errors } = await cleanDirs(targetDirs, mvnPath);
    reportCleaned(cleaned, errors, targetSizes);

    const endTime = process.hrtime.bigint();
    const timeTaken = Number(endTime - startTime) / 1e9;
    console.log(`\n${INFO} Time taken: ${timeTaken.toFixed(2)}s`);
}

await main();
