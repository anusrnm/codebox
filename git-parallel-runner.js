#!/usr/bin/env node

/**
 * Git Parallel Command Runner
 * 
 * Run git commands across multiple folders in parallel with progress tracking
 * 
 * Usage:
 *   node git-parallel-runner.js [options]
 * 
 * Options:
 *   --dirs <paths>         Comma-separated list of directories (default: scan current directory)
 *   --commands <cmds>      Comma-separated git commands (default: "status,branch")
 *   --depth <n>            Scan depth for git repos (default: 1)
 *   --concurrency <n>      Max parallel executions (default: CPU cores)
 *   --exclude <patterns>   Comma-separated patterns to exclude (e.g., node_modules,*.tmp)
 *   --timeout <ms>         Command timeout in milliseconds (default: 30000)
 *   --output <file>        Save results to JSON file
 *   --no-progress          Disable progress bar
 *   --verbose              Show detailed output
 *   --help                 Show this help
 * 
 * Examples:
 *   node git-parallel-runner.js
 *   node git-parallel-runner.js --commands "pull,status"
 *   node git-parallel-runner.js --dirs "project1,project2,project3" --commands "fetch,log -1"
 */

import { readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { createInterface } from 'node:readline';

// ANSI color codes
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m'
};

// Parse command-line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        dirs: null,
        commands: ['status', 'branch'],
        depth: 1,
        concurrency: cpus().length,
        exclude: ['node_modules', '.git', 'dist', 'build', 'target'],
        timeout: 30000,
        output: null,
        showProgress: true,
        verbose: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '--dirs':
                options.dirs = args[++i]?.split(',').map(d => d.trim()).filter(Boolean);
                break;
            case '--commands':
                options.commands = args[++i]?.split(',').map(c => c.trim()).filter(Boolean);
                break;
            case '--depth':
                options.depth = parseInt(args[++i], 10);
                break;
            case '--concurrency':
                options.concurrency = parseInt(args[++i], 10);
                break;
            case '--exclude':
                options.exclude = args[++i]?.split(',').map(p => p.trim()).filter(Boolean);
                break;
            case '--timeout':
                options.timeout = parseInt(args[++i], 10);
                break;
            case '--output':
                options.output = args[++i];
                break;
            case '--no-progress':
                options.showProgress = false;
                break;
            case '--verbose':
                options.verbose = true;
                break;
            case '--help':
                showHelp();
                process.exit(0);
            default:
                if (!arg.startsWith('--') && !options.dirs) {
                    options.dirs = [arg];
                }
        }
    }

    return options;
}

function showHelp() {
    console.log(`
${colors.bright}Git Parallel Command Runner${colors.reset}

${colors.cyan}Usage:${colors.reset}
  node git-parallel-runner.js [options]

${colors.cyan}Options:${colors.reset}
  --dirs <paths>         Comma-separated list of directories
  --commands <cmds>      Comma-separated git commands (default: "status,branch")
  --depth <n>            Scan depth for git repos (default: 1)
  --concurrency <n>      Max parallel executions (default: ${cpus().length})
  --exclude <patterns>   Comma-separated patterns to exclude
  --timeout <ms>         Command timeout (default: 30000)
  --output <file>        Save results to JSON file
  --no-progress          Disable progress bar
  --verbose              Show detailed output
  --help                 Show this help

${colors.cyan}Examples:${colors.reset}
  ${colors.gray}# Scan current directory for git repos${colors.reset}
  node git-parallel-runner.js

  ${colors.gray}# Pull and check status in specific folders${colors.reset}
  node git-parallel-runner.js --dirs "proj1,proj2" --commands "pull,status"

  ${colors.gray}# Fetch all repos with custom concurrency${colors.reset}
  node git-parallel-runner.js --commands "fetch --all" --concurrency 10

  ${colors.gray}# Check branches in all subdirectories${colors.reset}
  node git-parallel-runner.js --depth 2 --commands "branch -a"
`);
}

// Check if directory is a git repository
async function isGitRepo(dir) {
    try {
        const gitDir = join(dir, '.git');
        const stats = await stat(gitDir);
        return stats.isDirectory();
    } catch {
        return false;
    }
}

// Scan directory for git repositories
async function scanForGitRepos(baseDir, depth, exclude, currentDepth = 0) {
    if (currentDepth > depth) return [];

    const repos = [];
    
    if (await isGitRepo(baseDir)) {
        repos.push(baseDir);
        return repos; // Don't scan subdirs of git repos
    }

    try {
        const entries = await readdir(baseDir, { withFileTypes: true });
        
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (exclude.some(pattern => entry.name.includes(pattern))) continue;

            const fullPath = join(baseDir, entry.name);
            const subRepos = await scanForGitRepos(fullPath, depth, exclude, currentDepth + 1);
            repos.push(...subRepos);
        }
    } catch (err) {
        // Silently skip inaccessible directories
    }

    return repos;
}

// Parse command string into arguments array, handling quotes
function parseCommandArgs(command) {
    const args = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        
        if ((char === '"' || char === "'") && !inQuotes) {
            inQuotes = true;
            quoteChar = char;
        } else if (char === quoteChar && inQuotes) {
            inQuotes = false;
            quoteChar = '';
        } else if (char === ' ' && !inQuotes) {
            if (current) {
                args.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }

    if (current) {
        args.push(current);
    }

    return args;
}

// Add directory to git safe.directory config
async function addSafeDirectory(dir) {
    return new Promise((resolve) => {
        // Convert Windows path to git-friendly format
        const gitPath = dir.replace(/\\/g, '/');
        
        const proc = spawn('git', ['config', '--global', '--add', 'safe.directory', gitPath], {
            windowsHide: true
        });

        proc.on('close', () => {
            resolve(); // Always resolve, even if it fails
        });

        proc.on('error', () => {
            resolve(); // Silently continue if config fails
        });
    });
}

// Execute a command in a directory
function executeCommand(dir, command, timeout) {
    return new Promise((resolve, reject) => {
        // Parse command into arguments, handling quoted strings
        const args = parseCommandArgs(command);
        
        const proc = spawn('git', args, {
            cwd: dir,
            windowsHide: true
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill();
            reject(new Error(`Command timed out after ${timeout}ms`));
        }, timeout);

        proc.stdout?.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr?.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) return;

            if (code === 0) {
                resolve({ success: true, stdout: stdout.trim(), stderr: stderr.trim() });
            } else {
                resolve({ 
                    success: false, 
                    stdout: stdout.trim(), 
                    stderr: stderr.trim(),
                    exitCode: code
                });
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            if (!timedOut) {
                reject(err);
            }
        });
    });
}

// Progress bar class
class ProgressBar {
    constructor(total, label = 'Progress') {
        this.total = total;
        this.current = 0;
        this.label = label;
        this.startTime = Date.now();
        this.enabled = true;
    }

    update(increment = 1) {
        if (!this.enabled) return;
        
        this.current += increment;
        const percentage = Math.floor((this.current / this.total) * 100);
        const filled = Math.floor(percentage / 2);
        const empty = 50 - filled;
        const bar = '█'.repeat(filled) + '░'.repeat(empty);
        
        const elapsed = Date.now() - this.startTime;
        const rate = this.current / (elapsed / 1000);
        const remaining = this.total - this.current;
        const eta = remaining / rate;
        const etaStr = eta < 60 ? `${Math.floor(eta)}s` : `${Math.floor(eta / 60)}m ${Math.floor(eta % 60)}s`;

        process.stdout.write(
            `\r${colors.cyan}${this.label}${colors.reset} [${colors.green}${bar}${colors.reset}] ` +
            `${colors.bright}${this.current}/${this.total}${colors.reset} ` +
            `${colors.gray}(${percentage}%) ETA: ${etaStr}${colors.reset}`
        );

        if (this.current === this.total) {
            const totalTime = ((Date.now() - this.startTime) / 1000).toFixed(2);
            process.stdout.write(
                `\r${colors.cyan}${this.label}${colors.reset} [${colors.green}${'█'.repeat(50)}${colors.reset}] ` +
                `${colors.bright}${this.total}/${this.total}${colors.reset} ` +
                `${colors.green}✓ Complete${colors.reset} (${totalTime}s)\n`
            );
        }
    }

    disable() {
        this.enabled = false;
    }
}

// Run commands in parallel with concurrency control
async function runParallel(repos, commands, options) {
    const totalTasks = repos.length * commands.length;
    const progress = new ProgressBar(totalTasks, 'Executing commands');
    
    if (!options.showProgress) {
        progress.disable();
    }

    const results = [];
    const queue = [];

    // Create all tasks
    for (const repo of repos) {
        for (const command of commands) {
            queue.push({ repo, command });
        }
    }

    // Process queue with concurrency limit
    const executing = new Set();
    
    for (const task of queue) {
        const promise = (async () => {
            const repoName = relative(process.cwd(), task.repo) || '.';
            
            try {
                // Add to safe.directory if needed
                await addSafeDirectory(task.repo);
                
                const result = await executeCommand(task.repo, task.command, options.timeout);
                
                const taskResult = {
                    repo: task.repo,
                    repoName,
                    command: task.command,
                    ...result,
                    timestamp: new Date().toISOString()
                };

                results.push(taskResult);

                if (options.verbose) {
                    if (!options.showProgress) {
                        console.log(`${colors.blue}[${repoName}]${colors.reset} git ${task.command}`);
                    }
                    if (result.success) {
                        if (result.stdout) {
                            console.log(`${colors.gray}${result.stdout}${colors.reset}`);
                        }
                    } else {
                        console.log(`${colors.red}Error: ${result.stderr || 'Command failed'}${colors.reset}`);
                    }
                }

                progress.update();
            } catch (err) {
                results.push({
                    repo: task.repo,
                    repoName,
                    command: task.command,
                    success: false,
                    error: err.message,
                    timestamp: new Date().toISOString()
                });
                
                if (options.verbose) {
                    console.log(`${colors.red}[${repoName}] Error: ${err.message}${colors.reset}`);
                }
                
                progress.update();
            }
        })();

        executing.add(promise);

        promise.finally(() => executing.delete(promise));

        // Wait if we've reached concurrency limit
        if (executing.size >= options.concurrency) {
            await Promise.race(executing);
        }
    }

    // Wait for remaining tasks
    await Promise.all(executing);

    return results;
}

// Generate summary report
function generateSummary(results, repos, commands, options) {
    const summary = {
        timestamp: new Date().toISOString(),
        configuration: {
            repositories: repos.length,
            commands: commands.length,
            concurrency: options.concurrency,
            totalTasks: results.length
        },
        statistics: {
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            successRate: ((results.filter(r => r.success).length / results.length) * 100).toFixed(2) + '%'
        },
        byRepository: {}
    };

    // Group results by repository
    for (const result of results) {
        if (!summary.byRepository[result.repoName]) {
            summary.byRepository[result.repoName] = {
                total: 0,
                successful: 0,
                failed: 0,
                commands: []
            };
        }

        const repoStats = summary.byRepository[result.repoName];
        repoStats.total++;
        if (result.success) {
            repoStats.successful++;
        } else {
            repoStats.failed++;
        }
        repoStats.commands.push({
            command: result.command,
            success: result.success,
            output: result.stdout || result.stderr || result.error
        });
    }

    return summary;
}

// Main function
async function main() {
    const options = parseArgs();
    const startTime = Date.now();

    console.log(`${colors.bright}${colors.cyan}Git Parallel Command Runner${colors.reset}\n`);

    // Determine directories to process
    let repos = [];
    if (options.dirs) {
        // Use provided directories
        for (const dir of options.dirs) {
            const absPath = resolve(dir);
            if (await isGitRepo(absPath)) {
                repos.push(absPath);
            } else {
                console.log(`${colors.yellow}Warning: ${dir} is not a git repository${colors.reset}`);
            }
        }
    } else {
        // Scan for git repositories
        console.log(`${colors.gray}Scanning for git repositories (depth: ${options.depth})...${colors.reset}`);
        repos = await scanForGitRepos(process.cwd(), options.depth, options.exclude);
        console.log(`${colors.green}Found ${repos.length} git repositories${colors.reset}\n`);
    }

    if (repos.length === 0) {
        console.log(`${colors.red}No git repositories found${colors.reset}`);
        process.exit(1);
    }

    // Display configuration
    console.log(`${colors.bright}Configuration:${colors.reset}`);
    console.log(`  Repositories: ${colors.bright}${repos.length}${colors.reset}`);
    console.log(`  Commands: ${colors.bright}${options.commands.join(', ')}${colors.reset}`);
    console.log(`  Concurrency: ${colors.bright}${options.concurrency}${colors.reset}`);
    console.log(`  Total tasks: ${colors.bright}${repos.length * options.commands.length}${colors.reset}\n`);

    // Run commands
    const results = await runParallel(repos, options.commands, options);

    // Generate summary
    const summary = generateSummary(results, repos, options.commands, options);

    // Display summary
    console.log(`\n${colors.bright}${colors.cyan}Summary:${colors.reset}`);
    console.log(`  Total tasks: ${colors.bright}${summary.configuration.totalTasks}${colors.reset}`);
    console.log(`  Successful: ${colors.green}${summary.statistics.successful}${colors.reset}`);
    console.log(`  Failed: ${colors.red}${summary.statistics.failed}${colors.reset}`);
    console.log(`  Success rate: ${colors.bright}${summary.statistics.successRate}${colors.reset}`);

    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`  Time taken: ${colors.bright}${elapsedTime}s${colors.reset}\n`);

    // Show failed tasks
    const failed = results.filter(r => !r.success);
    if (failed.length > 0 && !options.verbose) {
        console.log(`${colors.red}${colors.bright}Failed tasks:${colors.reset}`);
        for (const result of failed) {
            console.log(`  ${colors.red}✗${colors.reset} ${colors.blue}[${result.repoName}]${colors.reset} git ${result.command}`);
            console.log(`    ${colors.gray}${result.stderr || result.error}${colors.reset}`);
        }
        console.log();
    }

    // Save to file if requested
    if (options.output) {
        const outputData = {
            summary,
            results: results.map(r => ({
                repo: r.repoName,
                command: r.command,
                success: r.success,
                output: r.stdout || r.stderr || r.error,
                timestamp: r.timestamp
            }))
        };

        await writeFile(options.output, JSON.stringify(outputData, null, 2));
        console.log(`${colors.green}Results saved to: ${options.output}${colors.reset}\n`);
    }

    // Exit with error if any task failed
    process.exit(failed.length > 0 ? 1 : 0);
}

// Run the script
main().catch(err => {
    console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
    process.exit(1);
});
