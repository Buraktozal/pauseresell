const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SHOPIER_URL = 'https://www.shopier.com/pauseresell';
const PRODUCTS_FILE = path.join(__dirname, 'products.json');

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function getShopierProductCount() {
  console.log('Shopier sayfasi kontrol ediliyor...');
  const html = await fetchPage(SHOPIER_URL);

  // Cloudflare kontrolü
  if (html.includes('Just a moment')) {
    console.log('HATA: Cloudflare korumasi aktif. Tarayicidan deneyin.');
    return 0;
  }

  // const $product_count = 333;
  const countMatch = html.match(/\$product_count\s*=\s*(\d+)/);
  if (countMatch) {
    return parseInt(countMatch[1]);
  }

  const textMatch = html.match(/(\d+)\s*ürün/);
  if (textMatch) {
    return parseInt(textMatch[1]);
  }

  console.log('HATA: Urun sayisi bulunamadi.');
  return 0;
}

async function syncProducts() {
  const currentProducts = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
  console.log(`Site urun sayisi: ${currentProducts.length}`);

  const shopierCount = await getShopierProductCount();
  if (shopierCount === 0) {
    console.log('Shopier urun sayisi okunamadi. Islem iptal.');
    process.exit(1);
  }

  console.log(`Shopier urun sayisi: ${shopierCount}`);

  const diff = currentProducts.length - shopierCount;

  if (diff === 0) {
    console.log('\nUrun sayilari esit. Degisiklik yok.');
    return;
  }

  if (diff < 0) {
    console.log(`\nShopier'de ${Math.abs(diff)} yeni urun var. Bunlari manuel eklemeniz gerekiyor.`);
    return;
  }

  // Güvenlik: max %20 silme
  const maxRemoval = Math.floor(currentProducts.length * 0.2);
  if (diff > maxRemoval) {
    console.log(`\nUYARI: ${diff} urun silinecek ama guvenlik limiti ${maxRemoval}.`);
    console.log('Cok fazla urun silinmek uzere. products.json dosyasini elle duzenleyin.');
    process.exit(1);
  }

  // Son eklenen ürünleri sil (dizinin sonundan)
  const updatedProducts = currentProducts.slice(0, shopierCount);

  console.log(`\n${diff} urun siteden kaldirilacak:`);
  for (let i = shopierCount; i < currentProducts.length; i++) {
    const p = currentProducts[i];
    console.log(`  - ${p.realName || p.desc} (${p.price} TL)`);
  }

  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(updatedProducts, null, 2), 'utf8');
  console.log(`\nGuncellendi: ${currentProducts.length} -> ${updatedProducts.length} urun`);

  // Git commit ve push
  try {
    console.log('\nGit commit ve push yapiliyor...');
    execSync('git add products.json', { stdio: 'inherit' });
    execSync(`git commit -m "Sync: ${diff} urun Shopier'den kaldirildi"`, { stdio: 'inherit' });
    execSync('git push', { stdio: 'inherit' });
    console.log('\nBasarili! Site birkaç dakika icinde guncellenecek.');
  } catch (e) {
    console.log('\nproducts.json guncellendi ama git push yapilamadi.');
    console.log('Elle "git add products.json && git commit -m sync && git push" calistirin.');
  }
}

syncProducts().catch(err => {
  console.error('Hata:', err.message);
  process.exit(1);
});
