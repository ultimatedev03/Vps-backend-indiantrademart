import {
  isOpenSearchCatalogEnabled,
  reindexOpenSearchProducts,
} from '../lib/openSearchCatalog.js';

const recreate = process.argv.includes('--recreate');
const batchArg = process.argv.find((arg) => arg.startsWith('--batch='));
const batchSize = batchArg ? Number(batchArg.split('=')[1]) : 500;

if (!isOpenSearchCatalogEnabled()) {
  console.log('OpenSearch is not configured. Set OPENSEARCH_URL and OPENSEARCH_ENABLED=true.');
  process.exit(0);
}

try {
  const result = await reindexOpenSearchProducts({
    recreate,
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 500,
  });
  console.log(`OpenSearch reindex complete: ${result.index}, ${result.indexed} products indexed.`);
  process.exit(0);
} catch (error) {
  console.error('OpenSearch reindex failed:', error?.message || error);
  process.exit(1);
}
