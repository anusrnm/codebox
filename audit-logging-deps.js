#!/usr/bin/env node

import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join, resolve as _resolve, dirname } from "path";
import { cpus } from "os";
import { spawn, exec } from "child_process";

const LOGGING_INCLUDES = [
  "org.slf4j:*",
  "org.apache.logging.log4j:*",
  "log4j:*",
  "ch.qos.logback:*",
  "org.apache.commons:commons-logging",
  "*:reload4j",
  "com.lmax:disruptor",
].join(",");

const SLF4J_BINDINGS = new Set([
  "org.slf4j:slf4j-log4j12",
  "org.slf4j:slf4j-reload4j",
  "org.slf4j:slf4j-jdk14",
  "org.slf4j:slf4j-simple",
  "org.slf4j:slf4j-nop",
  "ch.qos.logback:logback-classic",
  "org.apache.logging.log4j:log4j-slf4j-impl",
  "org.apache.logging.log4j:log4j-slf4j2-impl",
]);

const LOG4J2_SLF4J_BRIDGES = new Set([
  "org.apache.logging.log4j:log4j-slf4j-impl",
  "org.apache.logging.log4j:log4j-slf4j2-impl",
]);

const CONFLICT_SEVERITY_ORDER = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function printHelp() {
  console.log(`Usage: node scripts/audit-logging-deps.js [options]

Options:
  --pomPath <path>          Path to pom.xml (default: pom.xml)
  --scope <scope>           Maven scope for dependency tree (default: runtime)
  --outputDir <path>        Output directory (default: target/logging-deps)
  --maxLibraries <n>        Limit number of libraries to scan (default: 0 = all)
  --concurrency <n>         Number of parallel Maven workers (default: cpu/2, max 8)
  --libs <a,b,c>            Comma-separated list of group:artifact:version
  --lib <gav>               Repeatable single library coordinate
  --noConflictReport        Skip conflict report generation
  --help                    Show this help
`);
}

function parseArgs(argv) {
  const options = {
    pomPath: "pom.xml",
    scope: "runtime",
    outputDir: "target/logging-deps",
    maxLibraries: 0,
    concurrency: Math.max(1, Math.min(8, Math.ceil(cpus().length / 2))),
    libs: [],
    conflictReport: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--pomPath") {
      options.pomPath = argv[++i];
      continue;
    }

    if (arg === "--scope") {
      options.scope = argv[++i];
      continue;
    }

    if (arg === "--outputDir") {
      options.outputDir = argv[++i];
      continue;
    }

    if (arg === "--maxLibraries") {
      options.maxLibraries = Number(argv[++i] || 0);
      continue;
    }

    if (arg === "--concurrency") {
      options.concurrency = Math.max(1, Number(argv[++i] || 1));
      continue;
    }

    if (arg === "--libs") {
      const value = argv[++i] || "";
      options.libs.push(
        ...value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
      continue;
    }

    if (arg === "--lib") {
      const value = (argv[++i] || "").trim();
      if (value) {
        options.libs.push(value);
      }
      continue;
    }

    if (arg === "--noConflictReport") {
      options.conflictReport = false;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function runCommand(command, args, cwd, allowFailure = false) {
  const resolvedCommand = process.platform === "win32" && command === "mvn" ? "mvn" : command;

  if (process.platform === "win32") {
    const quotedArgs = args.map((arg) => {
      if (/\s|"/.test(arg)) {
        return `"${arg.replace(/"/g, '\\"')}"`;
      }
      return arg;
    });

    const fullCommand = [resolvedCommand, ...quotedArgs].join(" ");

    return new Promise((resolve, reject) => {
      exec(
        fullCommand,
        {
          cwd,
          windowsHide: true,
          maxBuffer: 1024 * 1024 * 30,
        },
        (error, stdout, stderr) => {
          const code = error && typeof error.code === "number" ? error.code : 0;
          const result = {
            code,
            stdout: stdout || "",
            stderr: stderr || "",
            combined: `${stdout || ""}${stderr || ""}`,
          };

          if (!allowFailure && code !== 0) {
            const preview = (result.combined || "").trim().slice(-1500);
            reject(new Error(`${resolvedCommand} failed with exit code ${code}\n${preview}`));
            return;
          }

          resolve(result);
        }
      );
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(resolvedCommand, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      const result = {
        code: code ?? 0,
        stdout,
        stderr,
        combined: `${stdout}${stderr}`,
      };

      if (!allowFailure && result.code !== 0) {
        const preview = (result.combined || "").trim().slice(-1500);
        reject(new Error(`${resolvedCommand} failed with exit code ${result.code}\n${preview}`));
        return;
      }

      resolve(result);
    });
  });
}

function ensureDirectory(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileName(input) {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseDirectDependenciesFromListOutput(output) {
  const libs = new Set();
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^\[INFO\]\s+([^:\s]+):([^:\s]+):([^:\s]+):([^:\s]+):([^\s]+)\s*$/);
    if (!match) {
      continue;
    }

    const [, groupId, artifactId, type, version] = match;
    if (type !== "jar") {
      continue;
    }

    libs.add(`${groupId}:${artifactId}:${version}`);
  }

  return Array.from(libs).sort();
}

function parseLoggingArtifactsFromTreeOutput(output) {
  const artifacts = new Set();
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    if (!line.startsWith("[INFO]")) {
      continue;
    }

    let clean = line.replace(/^\[INFO\]\s+/, "");
    clean = clean.replace(/^[\s+\\\-|]+/, "");

    const parts = clean.split(":");
    if (parts.length < 5) {
      continue;
    }

    const [groupId, artifactId, type, version] = parts;
    if (type !== "jar") {
      continue;
    }

    if (!groupId || !artifactId || !version) {
      continue;
    }

    artifacts.add(`${groupId}:${artifactId}:${version}`);
  }

  return Array.from(artifacts).sort();
}

function buildTempPom(lib) {
  const parts = lib.split(":");
  if (parts.length !== 3) {
    throw new Error(`Invalid coordinate: ${lib}. Expected groupId:artifactId:version`);
  }

  const [groupId, artifactId, version] = parts;

  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>tmp.logging.audit</groupId>
  <artifactId>tmp-${artifactId}</artifactId>
  <version>1.0.0</version>

  <dependencies>
    <dependency>
      <groupId>${groupId}</groupId>
      <artifactId>${artifactId}</artifactId>
      <version>${version}</version>
    </dependency>
  </dependencies>
</project>
`;
}

function csvEscape(value) {
  const s = String(value ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

function writeSummaryCsv(summaryPath, rows) {
  const header = ["library", "status", "loggingArtifacts"];
  const lines = [header.map(csvEscape).join(",")];

  for (const row of rows) {
    lines.push(
      [row.library, row.status, row.loggingArtifacts]
        .map(csvEscape)
        .join(",")
    );
  }

  writeFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
}

function parseArtifactCoordinate(coordinate) {
  const parts = coordinate.split(":");
  if (parts.length < 3) {
    return null;
  }

  const groupId = parts[0];
  const artifactId = parts[1];
  const version = parts.slice(2).join(":");

  return {
    groupId,
    artifactId,
    ga: `${groupId}:${artifactId}`,
    version,
  };
}

function parseMajorVersion(version) {
  const match = String(version).match(/^(\d+)/);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

function buildArtifactIndex(row) {
  const coordinates = (row.loggingArtifacts || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const byGA = new Map();

  for (const coordinate of coordinates) {
    const parsed = parseArtifactCoordinate(coordinate);
    if (!parsed) {
      continue;
    }

    if (!byGA.has(parsed.ga)) {
      byGA.set(parsed.ga, new Set());
    }

    byGA.get(parsed.ga).add(parsed.version);
  }

  return {
    byGA,
    hasGA(ga) {
      return byGA.has(ga);
    },
    versionsFor(ga) {
      return Array.from(byGA.get(ga) || []).sort();
    },
    allGAs() {
      return Array.from(byGA.keys()).sort();
    },
  };
}

function analyzeRowConflicts(row) {
  if (row.status !== "ok") {
    return [];
  }

  const findings = [];
  const index = buildArtifactIndex(row);
  const allGAs = index.allGAs();

  const slf4jBindings = allGAs.filter((ga) => SLF4J_BINDINGS.has(ga));
  if (slf4jBindings.length > 1) {
    findings.push({
      library: row.library,
      severity: "high",
      rule: "MULTIPLE_SLF4J_BINDINGS",
      details: `Multiple SLF4J bindings detected: ${slf4jBindings.join(", ")}`,
    });
  }

  if (
    index.hasGA("org.apache.logging.log4j:log4j-to-slf4j") &&
    allGAs.some((ga) => LOG4J2_SLF4J_BRIDGES.has(ga))
  ) {
    findings.push({
      library: row.library,
      severity: "critical",
      rule: "LOG4J2_SLF4J_LOOP",
      details:
        "Detected log4j-to-slf4j with log4j-slf4j-impl/log4j-slf4j2-impl; this can create an infinite logging loop.",
    });
  }

  if (
    index.hasGA("org.slf4j:log4j-over-slf4j") &&
    (index.hasGA("org.slf4j:slf4j-log4j12") || index.hasGA("org.slf4j:slf4j-reload4j"))
  ) {
    findings.push({
      library: row.library,
      severity: "critical",
      rule: "LOG4J1_SLF4J_LOOP",
      details:
        "Detected log4j-over-slf4j with slf4j-log4j12/slf4j-reload4j; this can create an infinite logging loop.",
    });
  }

  const log4j2Versions = new Set();
  for (const ga of allGAs) {
    if (ga.startsWith("org.apache.logging.log4j:")) {
      for (const version of index.versionsFor(ga)) {
        log4j2Versions.add(version);
      }
    }
  }

  if (log4j2Versions.size > 1) {
    findings.push({
      library: row.library,
      severity: "high",
      rule: "MIXED_LOG4J2_VERSIONS",
      details: `Multiple Log4j2 versions detected: ${Array.from(log4j2Versions).sort().join(", ")}`,
    });
  }

  const slf4jApiVersions = index.versionsFor("org.slf4j:slf4j-api");
  if (slf4jApiVersions.length > 1) {
    findings.push({
      library: row.library,
      severity: "medium",
      rule: "MULTIPLE_SLF4J_API_VERSIONS",
      details: `Multiple slf4j-api versions detected: ${slf4jApiVersions.join(", ")}`,
    });
  }

  if (index.hasGA("org.apache.logging.log4j:log4j-slf4j2-impl")) {
    const hasSlf4jV1 = slf4jApiVersions.some((v) => parseMajorVersion(v) === 1);
    if (hasSlf4jV1) {
      findings.push({
        library: row.library,
        severity: "high",
        rule: "SLF4J_MAJOR_MISMATCH",
        details:
          "log4j-slf4j2-impl is present with slf4j-api 1.x; slf4j2-impl expects SLF4J 2.x.",
      });
    }
  }

  if (index.hasGA("org.apache.logging.log4j:log4j-slf4j-impl")) {
    const hasSlf4jV2 = slf4jApiVersions.some((v) => parseMajorVersion(v) === 2);
    if (hasSlf4jV2) {
      findings.push({
        library: row.library,
        severity: "high",
        rule: "SLF4J_MAJOR_MISMATCH",
        details:
          "log4j-slf4j-impl is present with slf4j-api 2.x; log4j-slf4j-impl targets SLF4J 1.7.x.",
      });
    }
  }

  if (index.hasGA("log4j:log4j")) {
    findings.push({
      library: row.library,
      severity: "medium",
      rule: "LEGACY_LOG4J1_PRESENT",
      details: `Legacy log4j 1.x detected: ${index.versionsFor("log4j:log4j").join(", ")}`,
    });
  }

  return findings;
}

function analyzeConflicts(rows) {
  const findings = [];

  for (const row of rows) {
    findings.push(...analyzeRowConflicts(row));
  }

  findings.sort((a, b) => {
    const sevA = CONFLICT_SEVERITY_ORDER[a.severity] ?? 99;
    const sevB = CONFLICT_SEVERITY_ORDER[b.severity] ?? 99;
    if (sevA !== sevB) {
      return sevA - sevB;
    }
    if (a.library !== b.library) {
      return a.library.localeCompare(b.library);
    }
    return a.rule.localeCompare(b.rule);
  });

  return findings;
}

function writeConflictsCsv(conflictsPath, findings) {
  const header = ["library", "severity", "rule", "details"];
  const lines = [header.map(csvEscape).join(",")];

  for (const finding of findings) {
    lines.push(
      [finding.library, finding.severity, finding.rule, finding.details]
        .map(csvEscape)
        .join(",")
    );
  }

  writeFileSync(conflictsPath, `${lines.join("\n")}\n`, "utf8");
}

function writeConflictsText(conflictsTextPath, findings) {
  const counts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const finding of findings) {
    if (counts[finding.severity] !== undefined) {
      counts[finding.severity] += 1;
    }
  }

  const lines = [
    "# Logging Conflict Report",
    "",
    `Total findings: ${findings.length}`,
    `Critical: ${counts.critical}`,
    `High: ${counts.high}`,
    `Medium: ${counts.medium}`,
    `Low: ${counts.low}`,
    "",
  ];

  if (findings.length === 0) {
    lines.push("No conflicts detected.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      lines.push(`- [${finding.severity.toUpperCase()}] ${finding.library} :: ${finding.rule} :: ${finding.details}`);
    }
  }

  writeFileSync(conflictsTextPath, `${lines.join("\n")}\n`, "utf8");
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;

      if (current >= items.length) {
        break;
      }

      results[current] = await mapper(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

async function ensureMaven(cwd) {
  await runCommand("mvn", ["-v"], cwd, false);
}

async function getResolvedDirectDependencies(options, repoRoot) {
  const result = await runCommand(
    "mvn",
    [
      "-f",
      options.pomPath,
      "dependency:list",
      "-DexcludeTransitive=true",
      `-DincludeScope=${options.scope}`,
    ],
    repoRoot,
    false
  );

  return parseDirectDependenciesFromListOutput(result.combined);
}

async function scanOneLibrary(lib, options, tmpRoot, reportsRoot, repoRoot) {
  const safeName = sanitizeFileName(lib);
  const libDir = join(tmpRoot, safeName);
  const pomFile = join(libDir, "pom.xml");
  const reportFile = join(reportsRoot, `${safeName}.txt`);

  ensureDirectory(libDir);
  writeFileSync(pomFile, buildTempPom(lib), "utf8");

  const result = await runCommand(
    "mvn",
    [
      "-f",
      pomFile,
      "dependency:tree",
      `-Dscope=${options.scope}`,
      `-Dincludes=${LOGGING_INCLUDES}`,
    ],
    repoRoot,
    true
  );

  writeFileSync(reportFile, result.combined, "utf8");

  if (result.code !== 0) {
    const message = (result.combined || "").trim().slice(-1000) || `mvn exited ${result.code}`;
    return {
      library: lib,
      status: "error",
      loggingArtifacts: message.replace(/\r?\n/g, " | "),
    };
  }

  const artifacts = parseLoggingArtifactsFromTreeOutput(result.combined);

  return {
    library: lib,
    status: "ok",
    loggingArtifacts: artifacts.join(";"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (Number.isNaN(options.maxLibraries) || options.maxLibraries < 0) {
    throw new Error("--maxLibraries must be a non-negative integer");
  }

  if (Number.isNaN(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be >= 1");
  }

  const pomAbs = _resolve(options.pomPath);
  if (!existsSync(pomAbs)) {
    throw new Error(`pom.xml not found: ${pomAbs}`);
  }

  const repoRoot = dirname(pomAbs);
  const outputRoot = _resolve(repoRoot, options.outputDir);
  const tmpRoot = join(outputRoot, "tmp");
  const reportsRoot = join(outputRoot, "reports");
  const summaryPath = join(outputRoot, "summary.csv");
  const conflictsPath = join(outputRoot, "conflicts.csv");
  const conflictsTextPath = join(outputRoot, "conflicts.txt");

  ensureDirectory(outputRoot);
  ensureDirectory(tmpRoot);
  ensureDirectory(reportsRoot);

  await ensureMaven(repoRoot);

  let libs = options.libs.filter(Boolean);
  if (libs.length === 0) {
    console.log("\n=== Discovering direct dependencies from Maven ===");
    libs = await getResolvedDirectDependencies(options, repoRoot);
  }

  libs = Array.from(new Set(libs));
  if (options.maxLibraries > 0) {
    libs = libs.slice(0, options.maxLibraries);
  }

  console.log(`\n=== Scanning ${libs.length} libraries (concurrency=${options.concurrency}) ===`);

  let completed = 0;
  const summaryRows = await mapWithConcurrency(libs, options.concurrency, async (lib) => {
    const row = await scanOneLibrary(lib, options, tmpRoot, reportsRoot, repoRoot);
    completed += 1;
    console.log(`[${completed}/${libs.length}] ${lib} -> ${row.status}`);
    return row;
  });

  summaryRows.sort((a, b) => a.library.localeCompare(b.library));
  writeSummaryCsv(summaryPath, summaryRows);

  if (options.conflictReport) {
    const findings = analyzeConflicts(summaryRows);
    writeConflictsCsv(conflictsPath, findings);
    writeConflictsText(conflictsTextPath, findings);

    const criticalCount = findings.filter((f) => f.severity === "critical").length;
    const highCount = findings.filter((f) => f.severity === "high").length;
    const mediumCount = findings.filter((f) => f.severity === "medium").length;

    console.log(`Conflict report: ${conflictsPath}`);
    console.log(`Conflict summary: critical=${criticalCount}, high=${highCount}, medium=${mediumCount}`);
  }

  console.log("\n=== Done ===");
  console.log(`Summary: ${summaryPath}`);
  console.log(`Per-library reports: ${reportsRoot}`);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
