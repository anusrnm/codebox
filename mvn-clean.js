#!/usr/bin/env node

import { readdirSync, statSync, existsSync, rmSync } from 'node:fs';
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

function findProjectsToClean(basePath) {
    const projects = [];
    for (const item of readdirSync(basePath)) {
        const itemPath = join(basePath, item);
        if (!statSync(itemPath).isDirectory()) continue;
        const pom = join(itemPath, 'pom.xml');
        const packageJson = join(itemPath, 'package.json');
        const targetFolder = join(itemPath, 'target');
        const nodeModules = join(itemPath, 'node_modules');
        if (existsSync(pom) && existsSync(targetFolder)) {
            projects.push({ path: itemPath, type: 'maven', cleanFolder: 'target' });
        } else if (existsSync(packageJson) && existsSync(nodeModules)) {
            projects.push({ path: itemPath, type: 'node', cleanFolder: 'node_modules' });
        }
    }
    return projects;
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

function reportProjects(projects, sizes) {
    console.log(`${INFO} Found ${projects.length} project(s) to clean.`);
    let totalBytes = Object.values(sizes).reduce((a, b) => a + b, 0);
    console.log(`${INFO} Total disk space that will be reclaimed: ${formatSize(totalBytes)}`);
    console.log(`\n${INFO} Projects to be cleaned:`);
    for (const proj of projects) {
        const size = sizes[proj.path] || 0;
        console.log(` - ${proj.path} (${proj.type}) (${formatSize(size)})`);
    }
}

async function cleanProjectAsync(proj) {
    const { path, type, cleanFolder } = proj;
    if (type === 'maven') {
        const mvnPath = resolveMvnPath();
        return new Promise((resolve) => {
            const proc = spawn(`${mvnPath} -q clean`, [], { cwd: path, shell: true });
            runningProcs.push(proc);
            proc.on('close', (code) => {
                runningProcs = runningProcs.filter(p => p !== proc);
                if (code === 0) {
                    resolve({ path, error: '' });
                } else {
                    resolve({ path, error: `Error executing mvn clean: exit code ${code}` });
                }
            });
            proc.on('error', (e) => {
                runningProcs = runningProcs.filter(p => p !== proc);
                resolve({ path, error: `OS error: ${e.message}` });
            });
        });
    } else if (type === 'node') {
        try {
            rmSync(join(path, cleanFolder), { recursive: true, force: true });
            return { path, error: '' };
        } catch (e) {
            return { path, error: `Error removing ${cleanFolder}: ${e.message}` };
        }
    } else {
        return { path, error: 'Unknown project type' };
    }
}

async function cleanProjects(projects, concurrency = os.cpus().length) {
    const cleaned = [];
    const errors = [];
    let shared = { index: 0, processed: 0 };

    spinnerInterval = setInterval(() => {
        process.stdout.write(`\r${spinnerChars[spinnerIndex++ % spinnerChars.length]} Cleaning... ${shared.processed}/${projects.length}`);
    }, 100);

    async function worker() {
        while (true) {
            if (abort) break;
            let proj;
            if (shared.index < projects.length) {
                proj = projects[shared.index++];
            } else {
                break;
            }
            const result = await cleanProjectAsync(proj);
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

function reportCleaned(cleaned, errors, sizes) {
    console.log(`\n${INFO} Cleaned projects:`);
    for (const c of cleaned) {
        console.log(` - ${c}`);
    }
    console.log(` ${INFO} Total cleaned projects: ${cleaned.length}`);

    if (errors.length > 0) {
        console.log(`\n${ERROR} Errors encountered:`);
        for (const { path, error } of errors) {
            console.log(` - ${path}: ${error}`);
        }
        console.log(` ${ERROR} Total errors: ${errors.length}`);
    }

    const reclaimedBytes = cleaned.reduce((sum, path) => sum + (sizes[path] || 0), 0);
    console.log(`\n${INFO} Total disk space reclaimed: ${formatSize(reclaimedBytes)}`);
}

function getCleanSizes(projects) {
    const sizes = {};
    for (const proj of projects) {
        const folder = join(proj.path, proj.cleanFolder);
        if (existsSync(folder)) {
            sizes[proj.path] = getDirSize(folder);
        }
    }
    return sizes;
}

async function main() {
    const { basePath, dryRun } = parseArgs();
    validateBasePath(basePath);

    const startTime = process.hrtime.bigint();

    const projects = findProjectsToClean(basePath);

    if (projects.length === 0) {
        const absolutePath = resolve(basePath);
        console.log(`${ERROR} No projects found to clean in '${absolutePath}'.`);
        return;
    }

    const sizes = getCleanSizes(projects);
    reportProjects(projects, sizes);

    if (dryRun) {
        console.log(`\n${INFO} Dry run: No projects were cleaned.`);
        return;
    }

    const { cleaned, errors } = await cleanProjects(projects);
    reportCleaned(cleaned, errors, sizes);

    const endTime = process.hrtime.bigint();
    const timeTaken = Number(endTime - startTime) / 1e9;
    console.log(`\n${INFO} Time taken: ${timeTaken.toFixed(2)}s`);
}

await main();
