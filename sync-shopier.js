const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SHOPIER_URL = 'https://www.shopier.com/pauseresell';
const PRODUCTS_FILE = path.join(__dirname, 'products.json');

async function getShopierProducts() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('Navigating to Shopier store...');
  await page.goto(SHOPIER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Wait for product cards to render
  await page.waitForSelector('.product-card-title', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Get total product count from page
  const totalText = await page.textContent('.addable_product_count-div').catch(() => '');
  const totalMatch = totalText.match(/(\d+)/);
  const expectedTotal = totalMatch ? parseInt(totalMatch[1]) : 0;
  console.log(`Shopier reports ${expectedTotal} total products`);

  // Scroll down repeatedly to load all products
  let prevCount = 0;
  let stableRounds = 0;

  while (stableRounds < 5) {
    // Scroll loader into view
    const loader = await page.$('.loader');
    if (loader) {
      await loader.scrollIntoViewIfNeeded().catch(() => {});
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    const currentCount = await page.$$eval('a[href*="/pauseresell/"]', links => {
      const ids = new Set();
      links.forEach(a => {
        const m = a.pathname.match(/\/pauseresell\/(\d+)/);
        if (m) ids.add(m[1]);
      });
      return ids.size;
    });

    console.log(`  Loaded ${currentCount} products so far...`);

    if (currentCount === prevCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }
    prevCount = currentCount;
  }

  // Extract all product data
  const shopierProducts = await page.$$eval('.product-card-body', cards => {
    return cards.map(card => {
      const link = card.querySelector('a[href*="/pauseresell/"]');
      const title = card.querySelector('.product-card-title');
      const priceEl = card.querySelector('.product-card-price');

      const href = link ? link.pathname : '';
      const idMatch = href.match(/\/pauseresell\/(\d+)/);

      // Get price text and clean it
      let price = '';
      if (priceEl) {
        price = priceEl.textContent.replace(/[^\d]/g, '').trim();
      }

      return {
        id: idMatch ? idMatch[1] : null,
        title: title ? title.textContent.trim() : '',
        price: price
      };
    }).filter(p => p.id);
  });

  console.log(`Extracted ${shopierProducts.length} products from Shopier`);
  await browser.close();

  return { products: shopierProducts, expectedTotal };
}

function normalizeTitle(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9çğıöşüâîû\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function syncProducts() {
  // Read current products.json
  const currentProducts = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
  console.log(`Current products.json has ${currentProducts.length} products`);

  // Get Shopier products
  const { products: shopierProducts, expectedTotal } = await getShopierProducts();

  // Compare: find products in our JSON that are NOT on Shopier
  // We match by price + normalized title keywords
  const shopierSet = new Set();
  shopierProducts.forEach(sp => {
    // Create a matching key: title + price
    const key = normalizeTitle(sp.title) + '|' + sp.price;
    shopierSet.add(key);
    // Also add just by price for fuzzy matching
    shopierSet.add('price:' + sp.price);
  });

  // If Shopier total matches our JSON total, no sync needed
  if (expectedTotal === currentProducts.length) {
    console.log('Product counts match! No sync needed.');
    return false;
  }

  if (expectedTotal > currentProducts.length) {
    console.log(`Shopier has MORE products (${expectedTotal}) than our JSON (${currentProducts.length}).`);
    console.log('New products may have been added on Shopier. Manual import needed.');
    return false;
  }

  // Shopier has fewer products - some were removed
  const removedCount = currentProducts.length - expectedTotal;
  console.log(`\n${removedCount} product(s) appear to have been removed from Shopier.`);

  // Try to identify which products were removed
  // Build shopier product signatures for matching
  const shopierSignatures = shopierProducts.map(sp => ({
    title: normalizeTitle(sp.title),
    price: sp.price
  }));

  const updatedProducts = currentProducts.filter(p => {
    const ourTitle = normalizeTitle(p.desc || '');
    const ourPrice = String(p.price).replace(/[^\d]/g, '');

    // Check if this product exists on Shopier
    const found = shopierSignatures.some(sp =>
      sp.price === ourPrice && (
        sp.title.includes(ourTitle) ||
        ourTitle.includes(sp.title) ||
        sp.title === ourTitle
      )
    );

    if (!found) {
      const displayName = p.realName || p.desc;
      console.log(`  REMOVING: ${displayName} (${p.price} TL)`);
    }
    return found;
  });

  // If we couldn't match well enough, fall back to count-based removal
  if (updatedProducts.length === currentProducts.length) {
    console.log('\nCould not identify specific removed products by name matching.');
    console.log(`Shopier says ${expectedTotal} products, we have ${currentProducts.length}.`);
    console.log('Products may need manual review.');
    return false;
  }

  // Write updated products.json
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(updatedProducts, null, 2), 'utf8');
  console.log(`\nUpdated products.json: ${currentProducts.length} -> ${updatedProducts.length} products`);
  return true;
}

syncProducts().then(changed => {
  if (changed) {
    console.log('\nSync complete! Products removed from JSON.');
    process.exit(0);
  } else {
    console.log('\nNo changes needed.');
    process.exit(0);
  }
}).catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
