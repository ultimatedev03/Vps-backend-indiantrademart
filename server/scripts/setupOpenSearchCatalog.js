import {
  ensureOpenSearchProductIndex,
  getOpenSearchIndex,
  isOpenSearchCatalogEnabled,
  pingOpenSearch,
} from '../lib/openSearchCatalog.js';

const recreate = process.argv.includes('--recreate');

if (!isOpenSearchCatalogEnabled()) {
  console.log('OpenSearch is not configured. Set OPENSEARCH_URL and OPENSEARCH_ENABLED=true.');
  process.exit(0);
}

try {
  await pingOpenSearch();
  const result = await ensureOpenSearchProductIndex({ recreate });
  console.log(`OpenSearch index ready: ${result.index || getOpenSearchIndex()}${result.created ? ' (created)' : ''}`);
  process.exit(0);
} catch (error) {
  console.error('OpenSearch setup failed:', error?.message || error);
  process.exit(1);
}
