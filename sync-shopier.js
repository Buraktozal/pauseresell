const https = require('https');
const fs = require('fs');
const path = require('path');

const SHOPIER_URL = 'https://www.shopier.com/pauseresell';
const PRODUCTS_FILE = path.join(__dirname, 'products.json');

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive'
      }
    };
    https.get(url, options, (res) => {
      console.log(`  HTTP ${res.statusCode} for ${url}`);
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`  Redirecting to: ${res.headers.location}`);
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function getShopierProductCount() {
  console.log('Fetching Shopier store page...');
  const html = await fetchPage(SHOPIER_URL);
  console.log(`Page size: ${html.length} bytes`);
  console.log(`Page preview: ${html.substring(0, 300).replace(/\s+/g, ' ')}`);

  // Look for: const $product_count = 333;
  const countMatch = html.match(/\$product_count\s*=\s*(\d+)/);
  if (countMatch) {
    const count = parseInt(countMatch[1]);
    console.log(`Shopier product count (from JS variable): ${count}`);
    return count;
  }

  // Fallback: look for "X ürün" pattern
  const textMatch = html.match(/(\d+)\s*ürün/);
  if (textMatch) {
    const count = parseInt(textMatch[1]);
    console.log(`Shopier product count (from text): ${count}`);
    return count;
  }

  console.log('ERROR: Could not find product count in Shopier page.');
  return 0;
}

async function syncProducts() {
  const currentProducts = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
  console.log(`Current products.json has ${currentProducts.length} products`);

  const shopierCount = await getShopierProductCount();

  if (shopierCount === 0) {
    console.log('Could not read Shopier product count. Aborting.');
    return false;
  }

  const diff = currentProducts.length - shopierCount;

  if (diff <= 0) {
    console.log(`Shopier: ${shopierCount}, Site: ${currentProducts.length}. No products to remove.`);
    if (diff < 0) {
      console.log(`Note: Shopier has ${Math.abs(diff)} more products. Consider importing them.`);
    }
    return false;
  }

  // Safety: max 20% removal per run
  const maxRemoval = Math.floor(currentProducts.length * 0.2);
  if (diff > maxRemoval) {
    console.log(`WARNING: ${diff} products to remove exceeds 20% safety limit (${maxRemoval}).`);
    console.log('Aborting. If intentional, update products.json manually.');
    return false;
  }

  // Remove products from the end of the array
  // (typically the most recently added / least important ones)
  const updatedProducts = currentProducts.slice(0, shopierCount);

  console.log(`\nRemoving ${diff} product(s) from the end of products.json:`);
  for (let i = shopierCount; i < currentProducts.length; i++) {
    const p = currentProducts[i];
    console.log(`  - ${p.realName || p.desc} (${p.price} TL)`);
  }

  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(updatedProducts, null, 2), 'utf8');
  console.log(`\nUpdated: ${currentProducts.length} -> ${updatedProducts.length} products`);
  return true;
}

syncProducts().then(changed => {
  console.log(changed ? '\nSync complete!' : '\nNo changes made.');
  process.exit(0);
}).catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
