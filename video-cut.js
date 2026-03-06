#!/usr/bin/env node

"use strict";

import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as _resolve, parse, join, extname, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const EPSILON = 0.000001;

function printHelp() {
  const text = `
video-cut.js

Remove multiple time ranges from a video and write one final output file.

Usage:
  node video-cut.js --input INPUT --discard START-END [--discard START-END ...] [options]
  bun  video-cut.js --input INPUT --discard START-END [--discard START-END ...] [options]

Required:
  --input, -i          Input video path

Discard ranges:
  --discard, -d        Discard range in HH:MM:SS(.ms)-HH:MM:SS(.ms)
                       Can be passed multiple times
  --discard-file       File with one discard range per line (same format)
                       Empty lines and # comments are ignored

Optional:
  --output, -o         Output file path (default: <input>.cut<ext>)
  --accurate           Force accurate mode (re-encode)
  --verbose            Show ffmpeg stderr output while running
  --keep-temp          Keep temporary working folder for debugging
  --help, -h           Show this help

Notes:
  - No npm dependencies are used.
  - Requires ffmpeg + ffprobe installed on PATH.
  - Default mode is fast stream copy; if it fails, script auto-falls back to accurate mode.

Examples:
  node video-cut.js -i input.mp4 -d 00:00:10-00:00:20 -d 00:01:00.500-00:01:05.000
  bun video-cut.js -i input.mp4 --discard-file discard-ranges.txt -o output.mp4
`.trim();
  console.log(text);
}

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function warn(message) {
  console.error(`Warning: ${message}`);
}

function info(message) {
  console.log(message);
}

function parseCli(argv) {
  const options = {
    input: "",
    output: "",
    discard: [],
    discardFile: "",
    accurate: false,
    verbose: false,
    keepTemp: false,
    help: false,
  };

  const takeValue = (i, current) => {
    if (current.includes("=")) {
      return { value: current.slice(current.indexOf("=") + 1), nextIndex: i };
    }
    if (i + 1 >= argv.length) {
      fail(`Missing value for ${current}`);
    }
    return { value: argv[i + 1], nextIndex: i + 1 };
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--accurate") {
      options.accurate = true;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg === "--keep-temp") {
      options.keepTemp = true;
      continue;
    }
    if (arg === "--input" || arg === "-i" || arg.startsWith("--input=")) {
      const { value, nextIndex } = takeValue(i, arg);
      options.input = value;
      i = nextIndex;
      continue;
    }
    if (arg === "--output" || arg === "-o" || arg.startsWith("--output=")) {
      const { value, nextIndex } = takeValue(i, arg);
      options.output = value;
      i = nextIndex;
      continue;
    }
    if (arg === "--discard" || arg === "-d" || arg.startsWith("--discard=")) {
      const { value, nextIndex } = takeValue(i, arg);
      options.discard.push(value);
      i = nextIndex;
      continue;
    }
    if (arg === "--discard-file" || arg.startsWith("--discard-file=")) {
      const { value, nextIndex } = takeValue(i, arg);
      options.discardFile = value;
      i = nextIndex;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseTimeToSeconds(text) {
  const trimmed = String(text).trim();
  const match = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid time format "${text}". Use HH:MM:SS(.ms)`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    throw new Error(`Invalid numeric time value "${text}"`);
  }
  if (minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) {
    throw new Error(`Out-of-range time value "${text}" (MM/SS must be < 60)`);
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function parseRange(text) {
  const value = String(text).trim();
  const match = /^([^,-]+)\s*[-,]\s*([^,-]+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid range "${text}". Use START-END`);
  }

  const start = parseTimeToSeconds(match[1]);
  const end = parseTimeToSeconds(match[2]);
  if (start < 0 || end < 0) {
    throw new Error(`Negative ranges are not allowed: "${text}"`);
  }
  if (end <= start + EPSILON) {
    throw new Error(`Range end must be greater than start: "${text}"`);
  }
  return { start, end, source: value };
}

function parseDiscardFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  const ranges = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    try {
      ranges.push(parseRange(line));
    } catch (error) {
      throw new Error(`In ${filePath}:${i + 1}: ${error.message}`);
    }
  }
  return ranges;
}

function normalizeRanges(ranges) {
  if (!ranges.length) {
    return [];
  }
  const sorted = ranges
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));

  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.start <= prev.end + EPSILON) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

function clampAndNormalizeDiscardRanges(ranges, durationSec) {
  const clamped = [];
  for (const range of ranges) {
    const start = Math.max(0, Math.min(durationSec, range.start));
    const end = Math.max(0, Math.min(durationSec, range.end));
    if (end > start + EPSILON) {
      clamped.push({ start, end });
    }
  }
  return normalizeRanges(clamped);
}

function computeKeepRanges(durationSec, discardRanges) {
  const keep = [];
  let cursor = 0;
  for (const discard of discardRanges) {
    if (discard.start > cursor + EPSILON) {
      keep.push({ start: cursor, end: discard.start });
    }
    cursor = Math.max(cursor, discard.end);
  }
  if (durationSec > cursor + EPSILON) {
    keep.push({ start: cursor, end: durationSec });
  }
  return keep;
}

function secForFfmpeg(n) {
  return (Math.round(n * 1000000) / 1000000).toString();
}

function secForPrint(n) {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}

function isSamePath(a, b) {
  return _resolve(a).toLowerCase() === _resolve(b).toLowerCase();
}

function commandExists(command, args = ["-version"]) {
  try {
    const result = spawnSync(command, args, {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function runCommand(bin, args, options = {}) {
  const { verbose = false, allowFailure = false } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (verbose && text.trim()) {
        process.stdout.write(text);
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (verbose && text.trim()) {
        process.stderr.write(text);
      }
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code === 0 || allowFailure) {
        resolve(result);
      } else {
        const brief = stderr.trim() || stdout.trim() || `Command exited with code ${code}`;
        reject(new Error(brief));
      }
    });
  });
}

async function probeDuration(inputPath, verbose) {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    inputPath,
  ];
  const result = await runCommand("ffprobe", args, { verbose });
  const value = Number((result.stdout || "").trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Unable to read media duration from ffprobe output: "${result.stdout.trim()}"`);
  }
  return value;
}

async function probeStreams(inputPath, verbose) {
  const args = ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", inputPath];
  const result = await runCommand("ffprobe", args, { verbose });
  const types = new Set(
    (result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  return {
    hasVideo: types.has("video"),
    hasAudio: types.has("audio"),
  };
}

function ensureOutputPath(inputPath, outputArg) {
  if (outputArg) {
    return _resolve(outputArg);
  }
  const parsed = parse(inputPath);
  return join(parsed.dir, `${parsed.name}.cut${parsed.ext}`);
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "video-cut-"));
}

function escapeConcatPath(p) {
  return p.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

async function runFastMode(inputPath, outputPath, keepRanges, tempDir, verbose) {
  info(`Mode: fast (stream copy)`);
  const ext = extname(outputPath) || ".mkv";
  const segmentPaths = [];
  for (let i = 0; i < keepRanges.length; i += 1) {
    const segment = keepRanges[i];
    const segmentDuration = segment.end - segment.start;
    if (segmentDuration <= EPSILON) {
      continue;
    }

    const segmentPath = join(tempDir, `seg_${String(i + 1).padStart(4, "0")}${ext}`);
    segmentPaths.push(segmentPath);

    info(
      `Cut ${i + 1}/${keepRanges.length}: ${secForPrint(segment.start)}s -> ${secForPrint(
        segment.end
      )}s`
    );

    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      verbose ? "warning" : "error",
      "-ss",
      secForFfmpeg(segment.start),
      "-i",
      inputPath,
      "-t",
      secForFfmpeg(segmentDuration),
      "-c",
      "copy",
      "-avoid_negative_ts",
      "1",
      segmentPath,
    ];
    await runCommand("ffmpeg", args, { verbose });
  }

  if (!segmentPaths.length) {
    throw new Error("No segments were produced in fast mode.");
  }

  const concatFilePath = join(tempDir, "concat.txt");
  const concatContent = segmentPaths.map((p) => `file '${escapeConcatPath(p)}'`).join("\n") + "\n";
  writeFileSync(concatFilePath, concatContent, "utf8");

  info(`Concatenating ${segmentPaths.length} segment(s)...`);
  const concatArgs = [
    "-y",
    "-hide_banner",
    "-loglevel",
    verbose ? "warning" : "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFilePath,
    "-c",
    "copy",
    outputPath,
  ];
  await runCommand("ffmpeg", concatArgs, { verbose });
}

function buildAccurateFilter(keepRanges, hasVideo, hasAudio) {
  const chain = [];

  for (let i = 0; i < keepRanges.length; i += 1) {
    const segment = keepRanges[i];
    const start = secForFfmpeg(segment.start);
    const end = secForFfmpeg(segment.end);
    if (hasVideo) {
      chain.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}]`);
    }
    if (hasAudio) {
      chain.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]`);
    }
  }

  if (hasVideo && hasAudio) {
    const inputs = [];
    for (let i = 0; i < keepRanges.length; i += 1) {
      inputs.push(`[v${i}]`);
      inputs.push(`[a${i}]`);
    }
    chain.push(`${inputs.join("")}concat=n=${keepRanges.length}:v=1:a=1[vout][aout]`);
    return { filter: chain.join(";"), map: ["-map", "[vout]", "-map", "[aout]"] };
  }

  if (hasVideo) {
    const inputs = [];
    for (let i = 0; i < keepRanges.length; i += 1) {
      inputs.push(`[v${i}]`);
    }
    chain.push(`${inputs.join("")}concat=n=${keepRanges.length}:v=1:a=0[vout]`);
    return { filter: chain.join(";"), map: ["-map", "[vout]"] };
  }

  const inputs = [];
  for (let i = 0; i < keepRanges.length; i += 1) {
    inputs.push(`[a${i}]`);
  }
  chain.push(`${inputs.join("")}concat=n=${keepRanges.length}:v=0:a=1[aout]`);
  return { filter: chain.join(";"), map: ["-map", "[aout]"] };
}

async function runAccurateMode(inputPath, outputPath, keepRanges, verbose) {
  info(`Mode: accurate (re-encode)`);
  const streams = await probeStreams(inputPath, verbose);
  if (!streams.hasVideo && !streams.hasAudio) {
    throw new Error("Input has no audio/video streams to process.");
  }

  const filterDef = buildAccurateFilter(keepRanges, streams.hasVideo, streams.hasAudio);
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    verbose ? "warning" : "error",
    "-i",
    inputPath,
    "-filter_complex",
    filterDef.filter,
    ...filterDef.map,
  ];

  if (streams.hasVideo) {
    args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18");
  }
  if (streams.hasAudio) {
    args.push("-c:a", "aac", "-b:a", "192k");
  }

  args.push(outputPath);
  await runCommand("ffmpeg", args, { verbose });
}

function loadAllDiscardRanges(options) {
  const all = [];

  for (const item of options.discard) {
    all.push(parseRange(item));
  }

  if (options.discardFile) {
    if (!existsSync(options.discardFile)) {
      throw new Error(`Discard file not found: ${options.discardFile}`);
    }
    all.push(...parseDiscardFile(options.discardFile));
  }

  return all;
}

async function main() {
  const options = parseCli(process.argv);
  if (options.help || process.argv.length <= 2) {
    printHelp();
    return;
  }

  if (!options.input) {
    fail("--input is required. Use --help for usage.");
  }

  if (!existsSync(options.input)) {
    fail(`Input not found: ${options.input}`);
  }

  if (!commandExists("ffmpeg") || !commandExists("ffprobe")) {
    fail(
      "ffmpeg and ffprobe are required on PATH. On Windows, install FFmpeg and ensure ffmpeg.exe and ffprobe.exe are available in your PATH."
    );
  }

  let allRanges;
  try {
    allRanges = loadAllDiscardRanges(options);
  } catch (error) {
    fail(error.message);
  }

  if (!allRanges.length) {
    fail("Provide at least one --discard range or --discard-file.");
  }

  const inputPath = _resolve(options.input);
  const outputPath = ensureOutputPath(inputPath, options.output);
  if (isSamePath(inputPath, outputPath)) {
    fail("Output path must be different from input path.");
  }

  const outputDir = dirname(outputPath);
  mkdirSync(outputDir, { recursive: true });

  info(`Input:  ${inputPath}`);
  info(`Output: ${outputPath}`);

  let duration;
  try {
    duration = await probeDuration(inputPath, options.verbose);
  } catch (error) {
    fail(`Failed to probe input duration: ${error.message}`);
  }

  const normalized = normalizeRanges(allRanges);
  const discardRanges = clampAndNormalizeDiscardRanges(normalized, duration);
  if (!discardRanges.length) {
    fail("All discard ranges are outside media duration. Nothing to cut.");
  }

  const keepRanges = computeKeepRanges(duration, discardRanges);
  if (!keepRanges.length) {
    fail("Discard ranges remove the entire file. No output would remain.");
  }

  info(`Duration: ${secForPrint(duration)}s`);
  info(`Discard segments: ${discardRanges.length}`);
  info(`Keep segments: ${keepRanges.length}`);

  let tempDir = "";
  const cleanup = () => {
    if (!tempDir || options.keepTemp) {
      return;
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  };

  const onInterrupt = () => {
    cleanup();
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  try {
    if (options.accurate) {
      await runAccurateMode(inputPath, outputPath, keepRanges, options.verbose);
    } else {
      tempDir = makeTempDir();
      try {
        await runFastMode(inputPath, outputPath, keepRanges, tempDir, options.verbose);
      } catch (fastError) {
        warn(`Fast mode failed: ${fastError.message}`);
        warn("Falling back to accurate mode...");
        await runAccurateMode(inputPath, outputPath, keepRanges, options.verbose);
      }
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    cleanup();
  }

  info("Done.");
}

main().catch((error) => {
  fail(error.message || String(error));
});
