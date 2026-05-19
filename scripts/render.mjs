#!/usr/bin/env node

import { access, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";

const DEFAULT_INPUT = "index.html";
const DEFAULT_OUTPUT = "camp-publishing-poster.png";
const DEFAULT_COMPRESSED_OUTPUT = "camp-publishing-poster.jpg";
const MAX_COMPRESSED_BYTES = 100 * 1024;
const VIEWPORT = { width: 1920, height: 1080 };

function printHelp() {
  console.log(`Usage: npm run render -- [options]

Options:
  --input <path>       HTML file to render (default: ${DEFAULT_INPUT})
  --output <path>      Output image path (default: ${DEFAULT_OUTPUT}, or ${DEFAULT_COMPRESSED_OUTPUT} with --compress)
  --selector <css>     Element to screenshot (default: .poster)
  --compress           Output a JPEG under 100 KB
  --help               Show this help
`);
}

function parseArgs(argv) {
  const options = {
    input: DEFAULT_INPUT,
    output: undefined,
    selector: ".poster",
    compress: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--compress") {
      options.compress = true;
    } else if (arg === "--input") {
      options.input = readValue(argv, ++index, arg);
    } else if (arg === "--output") {
      options.output = readValue(argv, ++index, arg);
    } else if (arg === "--selector") {
      options.selector = readValue(argv, ++index, arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.output ??= options.compress
    ? DEFAULT_COMPRESSED_OUTPUT
    : DEFAULT_OUTPUT;

  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

async function renderPoster({ input, selector }) {
  const inputPath = path.resolve(input);
  await access(inputPath);

  const browser = await chromium.launch();
  const page = await browser.newPage({
    deviceScaleFactor: 1,
    viewport: VIEWPORT,
  });

  try {
    await page.goto(pathToFileURL(inputPath).href, {
      waitUntil: "networkidle",
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images, (image) => {
          if (image.complete) return undefined;
          return new Promise((resolve, reject) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", reject, { once: true });
          });
        }),
      );
    });

    const target = page.locator(selector).first();
    await target.waitFor({ state: "visible" });
    return await target.screenshot({ type: "png" });
  } finally {
    await browser.close();
  }
}

async function compressJpegUnderLimit(pngBuffer) {
  let best = undefined;
  let low = 1;
  let high = 95;

  while (low <= high) {
    const quality = Math.floor((low + high) / 2);
    const buffer = await sharp(pngBuffer)
      .jpeg({
        chromaSubsampling: "4:2:0",
        mozjpeg: true,
        progressive: true,
        quality,
      })
      .toBuffer();

    if (buffer.byteLength <= MAX_COMPRESSED_BYTES) {
      best = { buffer, quality };
      low = quality + 1;
    } else {
      high = quality - 1;
    }
  }

  if (!best) {
    const smallest = await sharp(pngBuffer)
      .jpeg({
        chromaSubsampling: "4:2:0",
        mozjpeg: true,
        progressive: true,
        quality: 1,
      })
      .toBuffer();

    throw new Error(
      `Could not fit JPEG under 100 KB. Smallest attempt was ${formatBytes(
        smallest.byteLength,
      )}.`,
    );
  }

  return best;
}

async function writeImage(output, buffer) {
  const outputPath = path.resolve(output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer);
  const result = await stat(outputPath);

  return { outputPath, bytes: result.size };
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (options.compress && path.extname(options.output).toLowerCase() !== ".jpg") {
    console.warn("Changing compressed output extension to .jpg");
    options.output = options.output.replace(/\.[^.]*$/, "") || options.output;
    options.output += ".jpg";
  }

  const screenshot = await renderPoster(options);
  const result = options.compress
    ? await compressJpegUnderLimit(screenshot)
    : { buffer: screenshot, quality: undefined };
  const written = await writeImage(options.output, result.buffer);
  const relativePath = path.relative(process.cwd(), written.outputPath);

  console.log(
    [
      `Rendered ${relativePath}`,
      `Size: ${formatBytes(written.bytes)}`,
      result.quality ? `JPEG quality: ${result.quality}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
