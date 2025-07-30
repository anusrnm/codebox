#!/usr/bin/env node

import { readdir, mkdir, writeFile, rm } from 'fs/promises';
import { resolve, join } from 'path';
import { spawn } from 'child_process';
import os from 'os';

const baseDir = process.argv[2] ? process.argv[2] : process.cwd();
console.log(`Searching in ${resolve(baseDir)}`);


function runGitCommand(args, cwd) {
    return new Promise((resolve) => {
        const proc = spawn("git", args, { cwd, encoding: 'utf8' });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (data) => { stdout += data; });
        proc.stderr?.on('data', (data) => { stderr += data; });
        proc.on('close', (status) => {
            resolve({ stdout, stderr, status });
        });
        proc.on('error', (e) => {
            resolve({ stdout, stderr: e.message, status: 1 });
        });
    });
}

async function processDir(dirPath) {
    let isGit = false;
    let hasLocalBranches = false;
    let isDirty = false;
    let branches = [];
    // Check if git repo
    const revParseRes = await runGitCommand(['rev-parse', '--is-inside-work-tree'], dirPath);
    isGit = revParseRes.stdout.trim() === 'true' && revParseRes.status === 0;
    if (isGit) {
        // Get branches
        const branchRes = await runGitCommand(['branch', '--list'], dirPath);
        const branchLines = branchRes.stdout
            .split('\n')
            .map(line => line.replace(/^\*?\s*/, '').trim())
            .filter(name => name && name !== 'master' && name !== 'main');
        hasLocalBranches = branchLines.length > 0;
        branches = branchLines;
        // Check dirty
        const statusRes = await runGitCommand(['status', '--porcelain', '-uno'], dirPath);
        isDirty = statusRes.stdout.trim().length > 0;
    }
    return {
        dirPath,
        isGit,
        hasLocalBranches,
        isDirty,
        branches
    };
}

async function main() {
    const logDir = join(process.cwd(), 'build');
    // Clean logDir at start

    try {
        await rm(logDir, { recursive: true, force: true });
    } catch {}
    await mkdir(logDir, { recursive: true });
    let interrupted = false;
    /**
     * Summarizes the results of directory processing.
     * "Can't" refers to directories that cannot be moved because they have local branches or uncommitted changes.
     * "Move" refers to directories that are clean and have no local branches, and can be moved safely.
     */
    async function summarize() {
        // write dirPath and logFileUri to a file under build logs
        const summaryFile = join(logDir, 'summary.txt');
        await writeFile(summaryFile, '', 'utf8');
        const logStream = (await import('fs')).createWriteStream(summaryFile);
        let cannotMoveCount = 0, canMoveCount = 0;
        for (const r of results) {
            if (r && (r.hasLocalBranches || r.isDirty)) {
                cannotMoveCount++;
                logStream.write(`Can't: ${r.dirPath} [${r.logFileUri}]\n`);
            } else {
                canMoveCount++;
                logStream.write(`Move : ${r.dirPath} [${r.logFileUri}]\n`);
            }
        }
        console.log(`\nSummary:`);
        console.log(`Can't: ${cannotMoveCount} Move: ${canMoveCount}`);
        console.log(`logFile: "${summaryFile}"`); // Use forward slashes for consistency
        logStream.write(`\nSummary:\nCan't: ${cannotMoveCount} Move: ${canMoveCount}\n`);
        logStream.end();
    }

    process.on('SIGINT', () => {
        interrupted = true;
        process.stdout.write('\nInterrupted by user. Cleaning up...\n');
        summarize();
        process.exit(0);
    });

    const items = await readdir(baseDir, { withFileTypes: true });
    const dirPaths = items
        .filter(item => item.isDirectory())
        .filter(item => !item.name.startsWith('.')) // Ignore hidden directories
        .map(item => join(baseDir, item.name));

    process.stdout.write(`Found ${dirPaths.length} directories.\n`);
    const total = dirPaths.length;
    let completed = 0;
    const results = [];
    const concurrency = Math.min(os.cpus().length, total);

    function showProgress() {
        process.stdout.write(`\rProcessing: ${completed}/${total} (${Math.round((completed/total)*100)}%)`);
    }

    // Use Promise.allSettled for parallel execution with concurrency
    // Chunk the dirPaths into batches for concurrency
    async function processBatch(batch) {
        const batchResults = await Promise.allSettled(batch.map(async dirPath => {
            const result = await processDir(dirPath);
            // Use sanitized directory name only
            const dirName = dirPath.split(/[/\\]/).filter(Boolean).pop();
            const safeName = dirName.replace(/[^a-zA-Z0-9._-]/g, '_');
            const logFile = join(logDir, `${safeName}.json`);
            let logFileUri = encodeURI(`file://${logFile.replace(/\\/g, '/')}`);
            result.logFileUri = logFileUri;
            await writeFile(logFile, JSON.stringify(result, null, 2), 'utf8');
            return result;
        }));
        for (const r of batchResults) {
            completed++;
            showProgress();
            results.push(r.status === 'fulfilled' ? r.value : null);
        }
    }

    // Split dirPaths into chunks
    function chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    const batches = chunkArray(dirPaths, concurrency);
    for (const batch of batches) {
        await processBatch(batch);
    }
    process.stdout.write('\nDone processing directories.\n');
    if (!interrupted) {
        summarize();
    }
}

main();