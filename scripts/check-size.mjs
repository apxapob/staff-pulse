import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const budgetBytes = 200 * 1024;
const outputDirectory = resolve(process.argv[2] ?? 'dist');
const includedExtensions = new Set(['.html', '.css', '.js', '.svg']);

async function collectAssets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const assets = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectAssets(path);
      if (!entry.isFile() || !includedExtensions.has(extname(entry.name).toLowerCase())) return [];

      const contents = await readFile(path);
      return [
        {
          name: relative(outputDirectory, path).replaceAll('\\', '/'),
          raw: contents.byteLength,
          gzip: gzipSync(contents, { level: 6 }).byteLength,
        },
      ];
    }),
  );

  return assets.flat();
}

const kibibytes = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`;

try {
  const assets = await collectAssets(outputDirectory);
  if (!assets.some((asset) => asset.name === 'index.html')) {
    throw new Error(`No index.html found in ${outputDirectory}. Run npm run build first.`);
  }

  assets.sort((left, right) => right.gzip - left.gzip || left.name.localeCompare(right.name));
  for (const asset of assets) {
    console.info(`${asset.name}: ${kibibytes(asset.raw)} raw / ${kibibytes(asset.gzip)} gzip`);
  }

  const totalBytes = assets.reduce((sum, asset) => sum + asset.gzip, 0);
  console.info(`Total HTML/CSS/JS/SVG gzip: ${kibibytes(totalBytes)} / ${kibibytes(budgetBytes)}`);
  if (totalBytes > budgetBytes) {
    console.error(`Bundle budget exceeded by ${kibibytes(totalBytes - budgetBytes)}.`);
    process.exitCode = 1;
  } else {
    console.info(`Bundle budget passed (${assets.length} files).`);
  }
} catch (error) {
  console.error(`Bundle size check failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
