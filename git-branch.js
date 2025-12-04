#!/usr/bin/env node

/**
 * Git Branch Scanner Script
 *
 * This script scans a base directory for subdirectories, identifies Git repositories,
 * checks for local branches (excluding specified defaults) and uncommitted changes,
 * and generates logs and summaries. It helps determine which directories can be
 * safely "moved" (clean repos with no extra branches) versus those that "can't"
 * (have branches or uncommitted changes).
 *
 * Usage:
 *   node git-branch.js [baseDir] [options]
 *
 * Options:
 *   --dry-run          Simulate without writing files
 *   --exclude <pattern> Comma-separated glob patterns to exclude directories
 *   --output-dir <path> Custom output directory (default: 'build')
 *   --html             Generate HTML output with sortable table
 *   --verbose          Enable verbose logging
 *   --max-dirs <n>     Limit number of directories to process
 *   --concurrency <n>  Number of concurrent processes (default: CPU count)
 *   --exclude-branches <list> Comma-separated branch names to exclude (default: master,main)
 *   --help             Show this help message
 *
 * Requirements:
 *   - Node.js 18+
 *   - Git installed and accessible
 *
 * Output:
 *   - JSON files for each directory in output dir
 *   - summary.txt with counts and details
 *   - Optional: index.html with sortable table
 *
 * Security Notes:
 *   - Sanitizes file paths to prevent traversal attacks
 *   - Avoids logging sensitive Git data
 */

import { readdir, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, basename, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

// Parse command-line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        baseDir: process.cwd(),
        dryRun: false,
        excludePatterns: [],
        outputDir: 'build',
        html: false,
        verbose: false,
        maxDirs: null,
        concurrency: Math.min(os.cpus().length, 8), // Cap at 8 for I/O
        excludeBranches: ['master', 'main'],
        help: false
    };

    const optionDefs = {
        '--dry-run': { type: 'flag', key: 'dryRun' },
        '--exclude': { type: 'value', key: 'excludePatterns', parser: v => v.split(',') },
        '--output-dir': { type: 'value', key: 'outputDir' },
        '--html': { type: 'flag', key: 'html' },
        '--verbose': { type: 'flag', key: 'verbose' },
        '--max-dirs': { type: 'value', key: 'maxDirs', parser: v => Number.parseInt(v, 10) },
        '--concurrency': { type: 'value', key: 'concurrency', parser: v => Number.parseInt(v, 10) },
        '--exclude-branches': { type: 'value', key: 'excludeBranches', parser: v => v.split(',') },
        '--help': { type: 'flag', key: 'help' }
    };

    let baseDirSet = false;
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        const def = optionDefs[arg];
        if (def) {
            parseOption(def, options, args, i);
            i++; // Increment after processing the option
            if (def.type === 'value') i++; // Skip the value
        } else if (!arg.startsWith('--') && !baseDirSet) {
            options.baseDir = arg;
            baseDirSet = true;
            i++;
        } else {
            i++;
        }
    }
    return options;
}

// Helper function to parse a single option
function parseOption(def, options, args, i) {
    if (def.type === 'flag') {
        options[def.key] = true;
    } else if (def.type === 'value' && i + 1 < args.length) {
        const val = def.parser ? def.parser(args[i + 1]) : args[i + 1];
        if (val !== undefined) options[def.key] = val;
    }
}

const opts = parseArgs();

if (opts.help) {
    console.log(`
Git Branch Scanner

Usage: node git-branch.js [baseDir] [options]

Options:
  --dry-run                 Simulate without writing files
  --exclude <patterns>      Comma-separated glob patterns to exclude (e.g., node_modules,build)
  --output-dir <path>       Custom output directory (default: build)
  --html                    Generate HTML output with sortable table
  --verbose                 Enable verbose logging
  --max-dirs <n>            Limit number of directories to process
  --concurrency <n>         Number of concurrent processes (default: CPU count, max 8)
  --exclude-branches <list> Comma-separated branch names to exclude (default: master,main)
  --help                    Show this help message

Example: node git-branch.js /path/to/repos --html --exclude node_modules,.git
`);
    process.exit(0);
}

// Validate Git availability
async function validateGit() {
    const res = await runGitCommand(['--version']);
    if (res.status !== 0) {
        console.error('Error: Git is not installed or not accessible.');
        process.exit(1);
    }
    if (opts.verbose) console.log('Git validated:', res.stdout.trim());
}

// Input validation for baseDir
function validateBaseDir(dir) {
    const resolved = resolve(dir);
    if (!isAbsolute(resolved) && !resolved.startsWith(process.cwd())) {
        console.error('Error: Base directory must be within current working directory or absolute.');
        process.exit(1);
    }
    return resolved;
}

opts.baseDir = validateBaseDir(opts.baseDir);

// Run Git command with timeout
function runGitCommand(args, cwd) {
    return new Promise((resolve) => {
        const proc = spawn('git', args, { cwd, encoding: 'utf8' });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
            proc.kill();
            resolve({ stdout, stderr: 'Command timed out', status: 1 });
        }, 30000); // 30s timeout
        proc.stdout?.on('data', (data) => { stdout += data; });
        proc.stderr?.on('data', (data) => { stderr += data; });
        proc.on('close', (status) => {
            clearTimeout(timeout);
            resolve({ stdout, stderr, status });
        });
        proc.on('error', (e) => {
            clearTimeout(timeout);
            resolve({ stdout, stderr: e.message, status: 1 });
        });
    });
}

// Process a single directory
async function processDir(dirPath) {
    let isGit = false;
    let hasLocalBranches = false;
    let isDirty = false;
    let branches = [];
    let error = null;

    try {
        // Check if Git repo
        const revParseRes = await runGitCommand(['rev-parse', '--is-inside-work-tree'], dirPath);
        isGit = revParseRes.stdout.trim() === 'true' && revParseRes.status === 0;
        if (!isGit) return { dirPath, isGit, hasLocalBranches, isDirty, branches, error };

        // Get branches
        const branchRes = await runGitCommand(['branch', '--list'], dirPath);
        if (branchRes.status !== 0) {
            error = `Branch list failed: ${branchRes.stderr}`;
            return { dirPath, isGit, hasLocalBranches, isDirty, branches, error };
        }
        const branchLines = branchRes.stdout
            .split('\n')
            .map(line => line.replace(/^\*?\s*/, '').trim())
            .filter(name => name && !opts.excludeBranches.includes(name));
        hasLocalBranches = branchLines.length > 0;
        branches = branchLines;

        // Check dirty status
        const statusRes = await runGitCommand(['status', '--porcelain', '-uno'], dirPath);
        if (statusRes.status !== 0) {
            error = `Status check failed: ${statusRes.stderr}`;
            return { dirPath, isGit, hasLocalBranches, isDirty, branches, error };
        }
        isDirty = statusRes.stdout.trim().length > 0;
    } catch (e) {
        error = `Processing error: ${e.message}`;
    }

    return { dirPath, isGit, hasLocalBranches, isDirty, branches, error };
}

// Sanitize filename
function sanitizeFilename(name) {
    return name.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
}

// Generate HTML output
function generateHtml(results, summaryFile) {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Git Branch Scan Results</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #121212; color: #e0e0e0; margin: 20px; }
        table { border-collapse: collapse; width: 100%; background-color: #1e1e1e; }
        th, td { border: 1px solid #333; padding: 8px; text-align: left; }
        th { background-color: #333; cursor: pointer; color: #fff; }
        tr:nth-child(even) { background-color: #404040; }
        p { color: #bbb; }
    </style>
</head>
<body>
    <p>Generated on ${new Date().toISOString()}</p>
    <table id="resultsTable">
        <thead>
            <tr>
                <th onclick="sortTable(0)">Directory</th>
                <th onclick="sortTable(1)">Is Git</th>
                <th onclick="sortTable(2)">Has Branches</th>
                <th onclick="sortTable(3)">Is Dirty</th>
                <th onclick="sortTable(4)">Branches</th>
                <th onclick="sortTable(5)">Status</th>
            </tr>
        </thead>
        <tbody>
            ${results.filter(Boolean).map(r => `
                <tr>
                    <td>${r.dirPath}</td>
                    <td>${r.isGit ? 'Yes' : 'No'}</td>
                    <td>${r.hasLocalBranches ? 'Yes' : 'No'}</td>
                    <td>${r.isDirty ? 'Yes' : 'No'}</td>
                    <td>${r.branches.join(', ')}</td>
                    <td>${r.error || 'OK'}</td>
                </tr>
            `).join('')}
        </tbody>
    </table>
    <script>
        function sortTable(n) {
            const table = document.getElementById('resultsTable');
            let rows, switching, i, x, y, shouldSwitch, dir, switchcount = 0;
            switching = true;
            dir = 'asc';
            while (switching) {
                switching = false;
                rows = table.rows;
                for (i = 1; i < (rows.length - 1); i++) {
                    shouldSwitch = false;
                    x = rows[i].getElementsByTagName('TD')[n];
                    y = rows[i + 1].getElementsByTagName('TD')[n];
                    if (dir == 'asc') {
                        if (x.innerHTML.toLowerCase() > y.innerHTML.toLowerCase()) {
                            shouldSwitch = true;
                            break;
                        }
                    } else if (dir == 'desc') {
                        if (x.innerHTML.toLowerCase() < y.innerHTML.toLowerCase()) {
                            shouldSwitch = true;
                            break;
                        }
                    }
                }
                if (shouldSwitch) {
                    rows[i].parentNode.insertBefore(rows[i + 1], rows[i]);
                    switching = true;
                    switchcount++;
                } else {
                    if (switchcount == 0 && dir == 'asc') {
                        dir = 'desc';
                        switching = true;
                    }
                }
            }
        }
    </script>
</body>
</html>`;
    return html;
}

// Main function
async function main() {
    await validateGit();
    console.log(`Searching in ${opts.baseDir}`);

    const logDir = join(process.cwd(), opts.outputDir);
    if (!opts.dryRun) {
        try {
            await rm(logDir, { recursive: true, force: true });
        } catch (e) {
            if (opts.verbose) console.log('Build dir cleanup warning:', e.message);
        }
        await mkdir(logDir, { recursive: true });
    }

    let interrupted = false;
    const results = [];

    // Summarize results
    async function summarize() {
        if (opts.dryRun) {
            console.log('Dry run: Skipping file writes');
            return;
        }
        const summaryFile = join(logDir, 'summary.txt');
        await writeFile(summaryFile, '', 'utf8');
        const logStream = (await import('node:fs')).createWriteStream(summaryFile);
        let cannotMoveCount = 0, canMoveCount = 0;
        for (const r of results) {
            if (r) {
                if (r.hasLocalBranches || r.isDirty) {
                    cannotMoveCount++;
                    const suffix = r.logFileUri ? ` [${r.logFileUri}]` : '';
                    logStream.write(`Can't: ${r.dirPath}${suffix}\n`);
                } else {
                    canMoveCount++;
                    logStream.write(`Move: ${r.dirPath}\n`);
                }
            }
        }
        console.log(`\nSummary:`);
        console.log(`Can't: ${cannotMoveCount} Move: ${canMoveCount}`);
        console.log(`Log file: "${summaryFile}"`);
        logStream.write(`\nSummary:\nCan't: ${cannotMoveCount} Move: ${canMoveCount}\n`);
        logStream.end();

        if (opts.html) {
            const htmlContent = generateHtml(results, summaryFile);
            const htmlFile = join(logDir, 'index.html');
            await writeFile(htmlFile, htmlContent, 'utf8');
            console.log(`HTML report: "${htmlFile}"`);
        }
    }

    process.on('SIGINT', () => {
        interrupted = true;
        console.log('\nInterrupted by user. Cleaning up...');
        summarize();
        process.exit(0);
    });

    let items;
    try {
        items = await readdir(opts.baseDir, { withFileTypes: true });
    } catch (e) {
        console.error('Error reading base directory:', e.message);
        process.exit(1);
    }

    let dirPaths = items
        .filter(item => item.isDirectory())
        .filter(item => !item.name.startsWith('.') || opts.includeHidden) // Optional hidden
        .map(item => join(opts.baseDir, item.name))
        .filter(dir => !opts.excludePatterns.some(pat => basename(dir).includes(pat)));

    if (opts.maxDirs) dirPaths = dirPaths.slice(0, opts.maxDirs);

    console.log(`Found ${dirPaths.length} directories.`);
    const total = dirPaths.length;
    let completed = 0;

    function showProgress() {
        const percent = Math.round((completed / total) * 100);
        process.stdout.write(`\rProcessing: ${completed}/${total} (${percent}%)`);
    }

    // Process in batches
    async function processBatch(batch) {
        const batchResults = await Promise.allSettled(batch.map(async dirPath => {
            const result = await processDir(dirPath);
            if (!opts.dryRun && (result.hasLocalBranches || result.isDirty)) {
                const dirName = basename(dirPath);
                const safeName = sanitizeFilename(dirName);
                const logFile = join(logDir, `${safeName}.json`);
                const logFileUri = encodeURI(`file://${logFile.replaceAll('\\', '/')}`);
                result.logFileUri = logFileUri;
                try {
                    await writeFile(logFile, JSON.stringify(result, null, 2), 'utf8');
                } catch (e) {
                    if (opts.verbose) console.log(`Write error for ${dirName}:`, e.message);
                }
            }
            return result;
        }));
        for (const r of batchResults) {
            completed++;
            showProgress();
            results.push(r.status === 'fulfilled' ? r.value : null);
        }
    }

    const batches = chunkArray(dirPaths, opts.concurrency);
    for (const batch of batches) {
        if (interrupted) break;
        await processBatch(batch);
    }
    console.log('\nDone processing directories.');
    if (!interrupted) await summarize();
}

// Utility: Chunk array
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

await main();
