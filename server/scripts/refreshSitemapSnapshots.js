import fs from 'fs/promises';
import path from 'path';

const origin = String(process.env.SITEMAP_SNAPSHOT_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3100}`).replace(/\/+$/, '');
const webRoot = process.env.SITEMAP_SNAPSHOT_WEB_ROOT || '/var/www/indiantrademart';
const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

const snapshots = [
  { source: '/sitemap.xml', target: 'sitemap.xml' },
  { source: '/sitemap-1cr.xml', target: 'sitemap-1cr.xml' },
  { source: '/sitemap-1cr.xml', target: `sitemap-1cr-${dateStamp}.xml` },
];

async function fetchXml(source) {
  const response = await fetch(`${origin}${source}`, {
    headers: {
      Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1',
      'User-Agent': 'IndianTradeMart-SitemapSnapshot/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to refresh ${source}: HTTP ${response.status}`);
  }

  const xml = await response.text();
  if (!xml.includes('<sitemapindex') && !xml.includes('<urlset')) {
    throw new Error(`Refusing to write invalid XML snapshot for ${source}`);
  }

  return xml;
}

async function writeAtomic(filePath, contents) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, contents, 'utf8');
  await fs.rename(tmpPath, filePath);
}

async function main() {
  await fs.mkdir(webRoot, { recursive: true });

  for (const snapshot of snapshots) {
    const xml = await fetchXml(snapshot.source);
    const targetPath = path.join(webRoot, snapshot.target);
    await writeAtomic(targetPath, xml);
    console.log(`${snapshot.target}: ${Buffer.byteLength(xml, 'utf8')} bytes`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
