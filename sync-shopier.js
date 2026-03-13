const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SHOPIER_URL = 'https://www.shopier.com/pauseresell';
const PRODUCTS_FILE = path.join(__dirname, 'products.json');

async function getShopierProductCount() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('Navigating to Shopier store...');
  await page.goto(SHOPIER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.product-card-title', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Get total product count - look for "333 ürün" text
  const countText = await page.evaluate(() => {
    // Try multiple selectors for the product count
    const el = document.querySelector('.addable_product_count-div');
    if (el && el.textContent.trim()) return el.textContent.trim();

    // Try finding "X ürün" text anywhere
    const all = document.body.innerText;
    const match = all.match(/(\d+)\s*ürün/);
    return match ? match[0] : '';
  });

  const countMatch = countText.match(/(\d+)/);
  const totalProducts = countMatch ? parseInt(countMatch[1]) : 0;

  console.log(`Shopier page says: "${countText}" -> ${totalProducts} products`);

  // Also get loaded product IDs for verification
  const loadedIds = await page.$$eval('a[href*="/pauseresell/"]', links => {
    const ids = new Set();
    links.forEach(a => {
      const m = a.pathname.match(/\/pauseresell\/(\d+)/);
      if (m) ids.add(m[1]);
    });
    return [...ids];
  });

  console.log(`Loaded ${loadedIds.length} product IDs from first page`);

  await browser.close();
  return { totalProducts, loadedIds };
}

async function syncProducts() {
  const currentProducts = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
  console.log(`Current products.json has ${currentProducts.length} products`);

  const { totalProducts, loadedIds } = await getShopierProductCount();

  // Safety check: if we couldn't get a count, abort
  if (totalProducts === 0) {
    console.log('ERROR: Could not read product count from Shopier. Aborting.');
    return false;
  }

  // Safety check: don't allow removing more than 20% of products at once
  const maxRemoval = Math.floor(currentProducts.length * 0.2);
  const diff = currentProducts.length - totalProducts;

  if (diff <= 0) {
    console.log(`Shopier has ${totalProducts} products, we have ${currentProducts.length}. No products removed.`);
    if (diff < 0) {
      console.log(`Note: Shopier has ${Math.abs(diff)} MORE products than our site. Consider importing new products.`);
    }
    return false;
  }

  if (diff > maxRemoval) {
    console.log(`WARNING: ${diff} products would be removed (>${maxRemoval} max allowed at 20%).`);
    console.log('This seems too many. Aborting to prevent accidental mass deletion.');
    console.log('If this is intentional, manually update products.json.');
    return false;
  }

  console.log(`\n${diff} product(s) removed from Shopier. Identifying which ones...`);

  // Strategy: check which products from our JSON are NOT on Shopier
  // We can only check the loaded IDs (first page ~24 products)
  // For the rest, we need to check individual product pages

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  // Check each product by trying to visit its Shopier page
  // Products in our JSON don't have Shopier IDs, so we match by price+title
  // Better approach: check if product pages return 404

  // Since we can't match individual products easily,
  // remove from the END of the array (oldest/last added products)
  // The user can also manually edit products.json

  // Actually, let's try a smarter approach:
  // Load ALL Shopier products by scrolling, with more patience
  const page = await context.newPage();
  await page.goto(SHOPIER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.product-card-title', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Aggressive scrolling to load all products
  let prevCount = 0;
  let stableRounds = 0;
  const maxScrollAttempts = 100;
  let attempts = 0;

  while (stableRounds < 8 && attempts < maxScrollAttempts) {
    attempts++;
    await page.evaluate(() => {
      const loader = document.querySelector('.loader');
      if (loader) loader.scrollIntoView({ behavior: 'instant' });
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(1500);

    const currentCount = await page.$$eval('a[href*="/pauseresell/"]', links => {
      const ids = new Set();
      links.forEach(a => {
        const m = a.pathname.match(/\/pauseresell\/(\d+)/);
        if (m) ids.add(m[1]);
      });
      return ids.size;
    });

    if (attempts % 10 === 0) {
      console.log(`  Scroll attempt ${attempts}: ${currentCount}/${totalProducts} products loaded...`);
    }

    if (currentCount === prevCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }
    prevCount = currentCount;

    // If we loaded all expected products, stop
    if (currentCount >= totalProducts) {
      console.log(`  All ${totalProducts} products loaded!`);
      break;
    }
  }

  // Get all loaded Shopier product titles and prices
  const shopierProducts = await page.$$eval('.product-card-body', cards => {
    return cards.map(card => {
      const title = card.querySelector('.product-card-title');
      const priceEl = card.querySelector('.product-card-price');
      let price = '';
      if (priceEl) {
        // Get only digits from price
        price = priceEl.textContent.replace(/[^\d]/g, '').trim();
      }
      return {
        title: title ? title.textContent.trim().toLowerCase() : '',
        price: price
      };
    }).filter(p => p.title);
  });

  await browser.close();

  console.log(`\nLoaded ${shopierProducts.length} products from Shopier (expected ${totalProducts})`);

  // Safety: if we didn't load at least 80% of Shopier products, abort
  if (shopierProducts.length < totalProducts * 0.8) {
    console.log(`WARNING: Only loaded ${shopierProducts.length}/${totalProducts} products. Not enough for safe comparison.`);
    console.log('Aborting to prevent incorrect removals.');
    return false;
  }

  // Build lookup: price -> list of shopier titles with that price
  const shopierByPrice = {};
  shopierProducts.forEach(sp => {
    if (!shopierByPrice[sp.price]) shopierByPrice[sp.price] = [];
    shopierByPrice[sp.price].push(sp.title);
  });

  // For each product in our JSON, check if it exists on Shopier
  const keepProducts = [];
  const removeProducts = [];

  currentProducts.forEach(p => {
    const ourPrice = String(p.price).replace(/[^\d]/g, '');
    const ourDesc = (p.desc || '').toLowerCase();

    // Check if Shopier has a product with the same price
    const samePriceProducts = shopierByPrice[ourPrice];

    if (samePriceProducts && samePriceProducts.length > 0) {
      // Found a product with same price - check if title matches roughly
      const matched = samePriceProducts.some(shopTitle => {
        // Check if the Shopier title contains our category keywords
        return shopTitle.includes(ourDesc.split(' ').pop()) || ourDesc.includes(shopTitle.split(' ').pop());
      });

      if (matched) {
        keepProducts.push(p);
        // Remove one match from the lookup to prevent double-matching
        const idx = samePriceProducts.findIndex(t => true);
        if (idx !== -1) samePriceProducts.splice(idx, 1);
      } else {
        // Price matches but title doesn't - still keep it (might be different naming)
        keepProducts.push(p);
      }
    } else {
      // No product with this price on Shopier
      removeProducts.push(p);
    }
  });

  if (removeProducts.length === 0) {
    console.log('Could not identify specific products to remove by price matching.');
    console.log('Products may need manual review.');
    return false;
  }

  // Final safety: only remove if the number roughly matches expected diff
  if (removeProducts.length > diff * 2) {
    console.log(`WARNING: Would remove ${removeProducts.length} products but only ${diff} expected.`);
    console.log('Mismatch too large. Aborting.');
    return false;
  }

  console.log(`\nRemoving ${removeProducts.length} product(s):`);
  removeProducts.forEach(p => {
    console.log(`  - ${p.realName || p.desc} (${p.price} TL)`);
  });

  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(keepProducts, null, 2), 'utf8');
  console.log(`\nUpdated products.json: ${currentProducts.length} -> ${keepProducts.length} products`);
  return true;
}

syncProducts().then(changed => {
  if (changed) {
    console.log('\nSync complete!');
    process.exit(0);
  } else {
    console.log('\nNo changes made.');
    process.exit(0);
  }
}).catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
